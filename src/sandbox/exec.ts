/**
 * Sandboxed exec tool — runs shell commands inside a Docker container
 * instead of on the host. Based on OpenClaw's bash-tools.exec-runtime.ts
 * pattern of redirecting `spawn()` to `docker exec`.
 */

import { spawn } from "node:child_process";
import type { SandboxContext } from "./types.js";
import type { NanoToolDefinition } from "../tools/types.js";
import { textResult } from "../tools/types.js";
import { buildDockerExecArgs } from "./docker.js";

const MAX_OUTPUT_CHARS = 50_000;
const DEFAULT_TIMEOUT_MS = 120_000; // 2 minutes

interface ExecResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  timedOut: boolean;
}

/**
 * Execute a command inside the sandbox container.
 */
export async function execInSandbox(
  sandbox: SandboxContext,
  command: string,
  opts?: {
    workdir?: string;
    env?: Record<string, string>;
    timeoutMs?: number;
    signal?: AbortSignal;
  },
): Promise<ExecResult> {
  const timeoutMs = opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  const dockerArgs = buildDockerExecArgs({
    containerName: sandbox.containerName,
    command,
    workdir: opts?.workdir ?? sandbox.containerWorkdir,
    env: opts?.env,
  });

  return new Promise<ExecResult>((resolve) => {
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let done = false;

    const child = spawn("docker", dockerArgs, {
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });

    // Close stdin immediately — sandbox exec doesn't accept input
    try {
      child.stdin.end();
    } catch {
      // ignore
    }

    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
      // Truncate if too large to prevent memory issues
      if (stdout.length > MAX_OUTPUT_CHARS * 2) {
        stdout = stdout.slice(-MAX_OUTPUT_CHARS);
      }
    });

    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
      if (stderr.length > MAX_OUTPUT_CHARS * 2) {
        stderr = stderr.slice(-MAX_OUTPUT_CHARS);
      }
    });

    const finish = (exitCode: number | null) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve({
        stdout: stdout.slice(-MAX_OUTPUT_CHARS),
        stderr: stderr.slice(-MAX_OUTPUT_CHARS),
        exitCode,
        timedOut,
      });
    };

    child.on("close", (code) => finish(code));
    child.on("error", (err) => {
      stderr += `\nProcess error: ${err.message}`;
      finish(1);
    });

    // Timeout handling
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        child.kill("SIGKILL");
      } catch {
        // ignore kill errors
      }
    }, timeoutMs);

    // Abort signal handling — guard against non-standard signal objects
    // (the Pi SDK may pass a signal-like object without addEventListener)
    const sig = opts?.signal;
    if (sig) {
      const onAbort = () => {
        try {
          child.kill("SIGKILL");
        } catch {
          // ignore
        }
      };
      if (sig.aborted) {
        onAbort();
      } else if (typeof sig.addEventListener === "function") {
        sig.addEventListener("abort", onAbort, { once: true });
        child.on("close", () => {
          if (typeof sig.removeEventListener === "function") {
            sig.removeEventListener("abort", onAbort);
          }
        });
      }
    }
  });
}

/**
 * Create a sandboxed exec tool that runs commands inside the Docker container.
 * This replaces the Pi SDK's built-in bash/exec tool when sandbox is enabled.
 */
export function createSandboxedExecTool(sandbox: SandboxContext): NanoToolDefinition {
  return {
    name: "exec",
    label: "exec",
    description: [
      "Run a shell command inside a sandboxed Docker container.",
      "The command runs in a secure, isolated environment with the workspace mounted at " + sandbox.containerWorkdir + ".",
      "Network access may be restricted depending on sandbox configuration.",
      "Parameters:",
      "  command (required) - The shell command to execute",
      "  workdir (optional) - Working directory inside the container (default: " + sandbox.containerWorkdir + ")",
      "  timeout (optional) - Timeout in seconds (default: 120)",
    ].join("\n"),
    parameters: {
      type: "object",
      required: ["command"],
      properties: {
        command: {
          type: "string",
          description: "The shell command to execute",
        },
        workdir: {
          type: "string",
          description: "Working directory inside the container",
        },
        timeout: {
          type: "number",
          description: "Timeout in seconds (default: 120)",
        },
      },
    },
    execute: async (
      _toolCallId: string,
      params: unknown,
      _onUpdate?: unknown,
      _ctx?: unknown,
      signal?: AbortSignal,
    ) => {
      const p = params as Record<string, unknown>;
      const command = typeof p.command === "string" ? p.command : "";
      if (!command.trim()) {
        return textResult("Error: command is required");
      }

      const workdir = typeof p.workdir === "string" ? p.workdir : undefined;
      const timeoutSec = typeof p.timeout === "number" ? p.timeout : 120;
      const timeoutMs = Math.max(1000, timeoutSec * 1000);

      try {
        const result = await execInSandbox(sandbox, command, {
          workdir,
          timeoutMs,
          signal,
        });

        const parts: string[] = [];
        if (result.timedOut) {
          parts.push(`[timed out after ${timeoutSec}s]`);
        }
        if (result.stdout.trim()) {
          parts.push(result.stdout.trim());
        }
        if (result.stderr.trim()) {
          parts.push(`[stderr]\n${result.stderr.trim()}`);
        }
        if (result.exitCode !== null && result.exitCode !== 0) {
          parts.push(`[exit code: ${result.exitCode}]`);
        }
        if (parts.length === 0) {
          parts.push("(no output)");
        }

        return textResult(parts.join("\n"));
      } catch (err) {
        return textResult(
          `Error executing command: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    },
  };
}
