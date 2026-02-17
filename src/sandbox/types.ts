/**
 * Sandbox configuration — modeled after OpenClaw's SandboxConfig/SandboxDockerConfig.
 * Provides Docker-based isolation for agent tool execution.
 */

export type SandboxScope = "session" | "shared";

export interface SandboxDockerConfig {
  /** Docker image to use (default: "node:22-slim"). */
  image: string;
  /** Container name prefix (default: "nano-sandbox-"). */
  containerPrefix: string;
  /** Working directory inside the container (default: "/workspace"). */
  workdir: string;
  /** Mount the root filesystem as read-only (default: true). */
  readOnlyRoot: boolean;
  /** tmpfs mounts for writable scratch space (default: ["/tmp", "/var/tmp"]). */
  tmpfs: string[];
  /** Docker network mode (default: "none" — fully isolated). */
  network: string;
  /** Drop all Linux capabilities (default: ["ALL"]). */
  capDrop: string[];
  /** Environment variables to inject into the container. */
  env: Record<string, string>;
  /** Shell command to run after container creation (e.g., install tools). */
  setupCommand?: string;
  /** Max number of PIDs (default: 256). */
  pidsLimit?: number;
  /** Memory limit (e.g., "512m"). */
  memory?: string;
  /** Memory+swap limit (e.g., "512m"). */
  memorySwap?: string;
  /** CPU limit (e.g., 1.0 = one core). */
  cpus?: number;
}

export interface SandboxConfig {
  /** Whether sandbox is enabled. */
  enabled: boolean;
  /** Container scope: "session" = per-session container, "shared" = one container for all. */
  scope: SandboxScope;
  /** Docker-specific configuration. */
  docker: SandboxDockerConfig;
  /** Max age in ms before a container is pruned (default: 24h). */
  maxAgeMs: number;
}

export interface SandboxContext {
  /** Whether sandbox is active for this session. */
  enabled: boolean;
  /** The Docker container name. */
  containerName: string;
  /** Working directory inside the container. */
  containerWorkdir: string;
  /** Host workspace directory (bind-mounted into container). */
  workspaceDir: string;
  /** The full sandbox config. */
  config: SandboxConfig;
}

export const DEFAULT_SANDBOX_IMAGE = "node:22-slim";
export const DEFAULT_SANDBOX_CONTAINER_PREFIX = "nano-sandbox-";
export const DEFAULT_SANDBOX_WORKDIR = "/workspace";
export const DEFAULT_SANDBOX_MAX_AGE_MS = 24 * 60 * 60 * 1000; // 24 hours

export function defaultSandboxDockerConfig(): SandboxDockerConfig {
  return {
    image: DEFAULT_SANDBOX_IMAGE,
    containerPrefix: DEFAULT_SANDBOX_CONTAINER_PREFIX,
    workdir: DEFAULT_SANDBOX_WORKDIR,
    readOnlyRoot: true,
    tmpfs: ["/tmp", "/var/tmp"],
    network: "none",
    capDrop: ["ALL"],
    env: { LANG: "C.UTF-8" },
  };
}

export function defaultSandboxConfig(): SandboxConfig {
  return {
    enabled: false,
    scope: "session",
    docker: defaultSandboxDockerConfig(),
    maxAgeMs: DEFAULT_SANDBOX_MAX_AGE_MS,
  };
}
