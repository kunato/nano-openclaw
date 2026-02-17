/**
 * Container pruning — garbage-collect stale sandbox containers.
 * Based on OpenClaw's sandbox/prune.ts pattern.
 */

import { execDocker, removeSandboxContainer } from "./docker.js";

export interface PruneResult {
  removed: string[];
  errors: string[];
}

/**
 * List all nano-sandbox containers (by label).
 */
async function listSandboxContainers(): Promise<
  Array<{ name: string; createdAtMs: number; running: boolean }>
> {
  const result = await execDocker(
    [
      "ps", "-a",
      "--filter", "label=nano-sandbox=1",
      "--format", "{{.Names}}\t{{.State}}",
    ],
    { allowFailure: true },
  );
  if (result.code !== 0 || !result.stdout.trim()) {
    return [];
  }

  const containers: Array<{ name: string; createdAtMs: number; running: boolean }> = [];
  for (const line of result.stdout.trim().split("\n")) {
    const [name, state] = line.split("\t");
    if (!name) continue;

    // Read creation timestamp from label
    let createdAtMs = 0;
    try {
      const labelResult = await execDocker(
        ["inspect", "-f", '{{ index .Config.Labels "nano-sandbox.createdAtMs" }}', name],
        { allowFailure: true },
      );
      if (labelResult.code === 0 && labelResult.stdout.trim()) {
        createdAtMs = parseInt(labelResult.stdout.trim(), 10) || 0;
      }
    } catch {
      // ignore
    }

    containers.push({
      name,
      createdAtMs,
      running: state === "running",
    });
  }

  return containers;
}

/**
 * Remove sandbox containers older than maxAgeMs.
 */
export async function pruneSandboxContainers(maxAgeMs: number): Promise<PruneResult> {
  const containers = await listSandboxContainers();
  const now = Date.now();
  const removed: string[] = [];
  const errors: string[] = [];

  for (const container of containers) {
    const age = now - container.createdAtMs;
    if (container.createdAtMs > 0 && age < maxAgeMs) {
      continue; // Still fresh
    }
    // No timestamp or expired — prune it
    try {
      await removeSandboxContainer(container.name);
      removed.push(container.name);
      console.log(`[sandbox] Pruned stale container: ${container.name} (age: ${Math.round(age / 1000 / 60)}min)`);
    } catch (err) {
      errors.push(`${container.name}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  return { removed, errors };
}

/**
 * Remove ALL nano-sandbox containers (used during shutdown).
 */
export async function removeAllSandboxContainers(): Promise<PruneResult> {
  const containers = await listSandboxContainers();
  const removed: string[] = [];
  const errors: string[] = [];

  for (const container of containers) {
    try {
      await removeSandboxContainer(container.name);
      removed.push(container.name);
    } catch (err) {
      errors.push(`${container.name}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  return { removed, errors };
}
