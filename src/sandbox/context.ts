/**
 * Resolve sandbox context for a session — decides whether to sandbox,
 * ensures the container exists, and returns the context needed by tools.
 * Based on OpenClaw's sandbox/context.ts.
 */

import fs from "node:fs/promises";
import path from "node:path";
import type { SandboxConfig, SandboxContext } from "./types.js";
import { ensureSandboxContainer } from "./docker.js";
import { pruneSandboxContainers } from "./prune.js";

/**
 * Copy bootstrap files (AGENTS.md, skills/) from host workspace into sandbox
 * workspace if they exist. Since the workspace is bind-mounted, this is a no-op
 * for bind-mount setups, but ensures files are available if the sandbox uses
 * a separate workspace directory in the future.
 */
async function ensureSandboxWorkspace(workspaceDir: string): Promise<void> {
  await fs.mkdir(workspaceDir, { recursive: true });

  // Ensure a skills directory exists in the workspace
  const skillsDir = path.join(workspaceDir, "skills");
  try {
    await fs.mkdir(skillsDir, { recursive: true });
  } catch {
    // ignore
  }
}

/**
 * Resolve sandbox context for a given session.
 * Returns null if sandbox is disabled.
 */
export async function resolveSandboxContext(params: {
  config: SandboxConfig;
  sessionKey: string;
  workspaceDir: string;
}): Promise<SandboxContext | null> {
  const { config, sessionKey, workspaceDir } = params;

  if (!config.enabled) {
    return null;
  }

  // Prune stale containers before creating new ones (fire-and-forget-ish)
  try {
    await pruneSandboxContainers(config.maxAgeMs);
  } catch (err) {
    console.warn(`[sandbox] Prune failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  await ensureSandboxWorkspace(workspaceDir);

  const containerName = await ensureSandboxContainer({
    sessionKey,
    workspaceDir,
    cfg: config,
  });

  return {
    enabled: true,
    containerName,
    containerWorkdir: config.docker.workdir,
    workspaceDir,
    config,
  };
}
