/**
 * Docker container lifecycle management for sandbox execution.
 * Based on OpenClaw's sandbox/docker.ts — handles create, start, reuse,
 * config hash checking, and security hardening.
 */

import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import type { SandboxConfig, SandboxDockerConfig } from "./types.js";

// ── Docker command helpers ────────────────────────────────────────────────────

export interface ExecDockerResult {
  stdout: string;
  stderr: string;
  code: number;
}

export async function execDocker(
  args: string[],
  opts?: { allowFailure?: boolean; timeoutMs?: number },
): Promise<ExecDockerResult> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      "docker",
      args,
      {
        timeout: opts?.timeoutMs ?? 30_000,
        maxBuffer: 10 * 1024 * 1024,
      },
      (err, stdout, stderr) => {
        const code = err && "code" in err ? (err.code as number) : err ? 1 : 0;
        if (err && !opts?.allowFailure) {
          reject(new Error(`docker ${args[0]} failed (code ${code}): ${stderr || err.message}`));
          return;
        }
        resolve({ stdout: stdout.toString(), stderr: stderr.toString(), code });
      },
    );
    // Safety: kill if stuck
    child.on("error", (err) => {
      if (!opts?.allowFailure) reject(err);
      else resolve({ stdout: "", stderr: String(err), code: 1 });
    });
  });
}

// ── Container state inspection ────────────────────────────────────────────────

export interface ContainerState {
  exists: boolean;
  running: boolean;
}

export async function dockerContainerState(name: string): Promise<ContainerState> {
  const result = await execDocker(
    ["inspect", "-f", "{{.State.Running}}", name],
    { allowFailure: true },
  );
  if (result.code !== 0) {
    return { exists: false, running: false };
  }
  const running = result.stdout.trim() === "true";
  return { exists: true, running };
}

// ── Docker image availability ─────────────────────────────────────────────────

async function ensureDockerImage(image: string): Promise<void> {
  const inspect = await execDocker(["image", "inspect", image], { allowFailure: true });
  if (inspect.code === 0) return;
  console.log(`[sandbox] Pulling image: ${image}`);
  await execDocker(["pull", image], { timeoutMs: 5 * 60_000 });
}

// ── Config hashing (detect config drift) ──────────────────────────────────────

export function computeSandboxConfigHash(cfg: {
  docker: SandboxDockerConfig;
  workspaceDir: string;
}): string {
  const data = JSON.stringify({
    image: cfg.docker.image,
    workdir: cfg.docker.workdir,
    readOnlyRoot: cfg.docker.readOnlyRoot,
    tmpfs: cfg.docker.tmpfs,
    network: cfg.docker.network,
    capDrop: cfg.docker.capDrop,
    env: cfg.docker.env,
    pidsLimit: cfg.docker.pidsLimit,
    memory: cfg.docker.memory,
    memorySwap: cfg.docker.memorySwap,
    cpus: cfg.docker.cpus,
    workspaceDir: cfg.workspaceDir,
  });
  return createHash("sha256").update(data).digest("hex").slice(0, 16);
}

export async function readContainerLabel(
  containerName: string,
  label: string,
): Promise<string | null> {
  const result = await execDocker(
    ["inspect", "-f", `{{ index .Config.Labels "${label}" }}`, containerName],
    { allowFailure: true },
  );
  if (result.code !== 0) return null;
  const raw = result.stdout.trim();
  if (!raw || raw === "<no value>") return null;
  return raw;
}

// ── Build `docker create` arguments ───────────────────────────────────────────

export function buildSandboxCreateArgs(params: {
  name: string;
  cfg: SandboxDockerConfig;
  workspaceDir: string;
  configHash: string;
}): string[] {
  const { name, cfg, workspaceDir, configHash } = params;
  const args = ["create", "--name", name];

  // Labels for management and config drift detection
  args.push("--label", "nano-sandbox=1");
  args.push("--label", `nano-sandbox.configHash=${configHash}`);
  args.push("--label", `nano-sandbox.createdAtMs=${Date.now()}`);

  // Security hardening (matches OpenClaw defaults)
  if (cfg.readOnlyRoot) {
    args.push("--read-only");
  }
  for (const entry of cfg.tmpfs) {
    args.push("--tmpfs", entry);
  }
  if (cfg.network) {
    args.push("--network", cfg.network);
  }
  for (const cap of cfg.capDrop) {
    args.push("--cap-drop", cap);
  }
  args.push("--security-opt", "no-new-privileges");

  // Resource limits
  if (typeof cfg.pidsLimit === "number" && cfg.pidsLimit > 0) {
    args.push("--pids-limit", String(cfg.pidsLimit));
  }
  if (cfg.memory) {
    args.push("--memory", cfg.memory);
  }
  if (cfg.memorySwap) {
    args.push("--memory-swap", cfg.memorySwap);
  }
  if (typeof cfg.cpus === "number" && cfg.cpus > 0) {
    args.push("--cpus", String(cfg.cpus));
  }

  // Environment variables
  for (const [key, value] of Object.entries(cfg.env)) {
    if (key.trim()) {
      args.push("--env", `${key}=${value}`);
    }
  }

  // Working directory and workspace bind mount
  args.push("--workdir", cfg.workdir);
  args.push("-v", `${workspaceDir}:${cfg.workdir}`);

  // Image + long-running command
  args.push(cfg.image, "sleep", "infinity");

  return args;
}

// ── Create and start a sandbox container ──────────────────────────────────────

async function createSandboxContainer(params: {
  name: string;
  cfg: SandboxDockerConfig;
  workspaceDir: string;
  configHash: string;
}): Promise<void> {
  await ensureDockerImage(params.cfg.image);

  const args = buildSandboxCreateArgs(params);
  await execDocker(args);
  await execDocker(["start", params.name]);

  if (params.cfg.setupCommand?.trim()) {
    console.log(`[sandbox] Running setup command in ${params.name}`);
    await execDocker(["exec", "-i", params.name, "sh", "-lc", params.cfg.setupCommand]);
  }
}

// ── Ensure a sandbox container exists and is running ──────────────────────────

function slugifySessionKey(sessionKey: string): string {
  return sessionKey
    .replace(/[^a-zA-Z0-9_-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 40);
}

export async function ensureSandboxContainer(params: {
  sessionKey: string;
  workspaceDir: string;
  cfg: SandboxConfig;
}): Promise<string> {
  const { cfg, workspaceDir, sessionKey } = params;
  const slug = cfg.scope === "shared"
    ? "shared"
    : slugifySessionKey(sessionKey);
  const containerName = `${cfg.docker.containerPrefix}${slug}`.slice(0, 63);

  const expectedHash = computeSandboxConfigHash({
    docker: cfg.docker,
    workspaceDir,
  });

  const state = await dockerContainerState(containerName);

  if (state.exists) {
    // Check for config drift
    const currentHash = await readContainerLabel(containerName, "nano-sandbox.configHash");
    if (currentHash && currentHash !== expectedHash) {
      console.log(`[sandbox] Config changed for ${containerName}, recreating...`);
      await execDocker(["rm", "-f", containerName], { allowFailure: true });
      await createSandboxContainer({
        name: containerName,
        cfg: cfg.docker,
        workspaceDir,
        configHash: expectedHash,
      });
    } else if (!state.running) {
      console.log(`[sandbox] Starting existing container: ${containerName}`);
      await execDocker(["start", containerName]);
    } else {
      console.log(`[sandbox] Reusing running container: ${containerName}`);
    }
  } else {
    console.log(`[sandbox] Creating new container: ${containerName}`);
    await createSandboxContainer({
      name: containerName,
      cfg: cfg.docker,
      workspaceDir,
      configHash: expectedHash,
    });
  }

  return containerName;
}

// ── Build `docker exec` arguments for running a command inside the container ──

export function buildDockerExecArgs(params: {
  containerName: string;
  command: string;
  workdir?: string;
  env?: Record<string, string>;
  tty?: boolean;
}): string[] {
  const args = ["exec", "-i"];
  if (params.tty) {
    args.push("-t");
  }
  if (params.workdir) {
    args.push("-w", params.workdir);
  }
  if (params.env) {
    for (const [key, value] of Object.entries(params.env)) {
      args.push("-e", `${key}=${value}`);
    }
  }
  args.push(params.containerName, "sh", "-lc", params.command);
  return args;
}

// ── Stop and remove a container ───────────────────────────────────────────────

export async function removeSandboxContainer(containerName: string): Promise<void> {
  await execDocker(["rm", "-f", containerName], { allowFailure: true });
}
