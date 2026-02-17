/**
 * Standalone test script that triggers subagent spawning end-to-end.
 *
 * Usage:
 *   npx tsx scripts/test-subagent.ts
 *
 * Requires MODEL_API_KEY in .env (or environment).
 * Does NOT require Discord or any channel — talks directly to AgentRunner.
 */

import { config } from "dotenv";
config();

import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { AgentRunner } from "../src/agent.js";
import { buildAnnounceMessage } from "../src/subagent.js";
import type { NanoConfig } from "../src/config.js";
import type { OutboundMessage } from "../src/channels/base.js";
import { defaultSandboxConfig } from "../src/sandbox/types.js";
import { defaultHeartbeatConfig } from "../src/heartbeat.js";

// ── Minimal config (no channels required) ─────────────────────────────

function buildTestConfig(): NanoConfig {
  const apiKey = process.env.MODEL_API_KEY;
  if (!apiKey) {
    console.error("ERROR: MODEL_API_KEY is required. Set it in .env or environment.");
    process.exit(1);
  }

  const thisFile = fileURLToPath(import.meta.url);
  const repoRoot = path.resolve(path.dirname(thisFile), "..");
  const workspaceDir = path.join(repoRoot, "workspace");
  const agentDir = path.join(os.tmpdir(), "nano-openclaw-test-subagent");

  return {
    provider: process.env.MODEL_PROVIDER || "anthropic",
    modelId: process.env.MODEL_ID || "claude-sonnet-4-20250514",
    apiKey,
    workspaceDir,
    codeDir: path.join(workspaceDir, "code"),
    agentDir,
    braveApiKey: undefined,
    puppeteerExecutable: undefined,
    sandbox: { ...defaultSandboxConfig(), enabled: false },
    channels: {
      discord: { enabled: false, token: "" },
      whatsapp: { enabled: false, authDir: "" },
      slack: { enabled: false, botToken: "", appToken: "" },
    },
    consolidation: { enabled: false, messageThreshold: 999 },
    heartbeat: { ...defaultHeartbeatConfig, enabled: false },
    scheduler: {},
  };
}

// ── Main ───────────────────────────────────────────────────────────────

async function main() {
  console.log("=== Subagent Test ===\n");

  const config = buildTestConfig();

  // Clean up stale state from previous runs so the agent starts fresh
  const fs = await import("node:fs/promises");
  try {
    await fs.rm(config.agentDir, { recursive: true, force: true });
    console.log(`Cleaned up: ${config.agentDir}`);
  } catch { /* ignore */ }

  console.log(`Agent dir: ${config.agentDir}`);
  console.log(`Model:     ${config.provider}/${config.modelId}\n`);

  const agent = new AgentRunner(config);
  await agent.init();

  // Track announced results + pending announce promises
  const announcements: Array<{
    label?: string;
    status: string;
    result: string;
    parentResponse?: string;
  }> = [];
  const pendingAnnounces: Promise<void>[] = [];

  // Wire announce callback — just log, no channel delivery needed
  agent.setAnnounceCallback(async (params) => {
    const registry = agent.getSubagentRegistry();
    const remaining = registry.countActiveForSession(params.parentSessionKey);

    const announceText = buildAnnounceMessage({
      task: params.task,
      label: params.label,
      status: params.status,
      result: params.result,
      startedAt: params.startedAt,
      endedAt: params.endedAt,
      remainingActiveChildren: remaining,
    });

    const entry: (typeof announcements)[number] = {
      label: params.label,
      status: params.status,
      result: params.result.slice(0, 300),
    };
    announcements.push(entry);

    console.log(`\n📣 [ANNOUNCE] "${params.label || params.task.slice(0, 40)}" → ${params.status}`);
    console.log(`   Result preview: ${params.result.slice(0, 150)}`);

    // Inject announce into parent session (same as index.ts does)
    // Track this as a pending promise so we wait for it before exiting
    const announcePromise = (async () => {
      const response = await agent.handleMessage({
        text: announceText,
        sessionKey: params.parentSessionKey,
        channelId: params.parentChannelId,
        userId: "system",
        userName: "subagent-announce",
        isGroup: false,
      }, {});

      if (response?.text && response.text !== "NO_REPLY") {
        entry.parentResponse = response.text;
        console.log(`\n💬 [PARENT RESPONSE to announce] ${response.text.slice(0, 500)}`);
      } else {
        console.log(`\n💬 [PARENT RESPONSE to announce] (NO_REPLY or empty)`);
      }
    })();

    pendingAnnounces.push(announcePromise);
    await announcePromise;
  });

  // ── Send a single message that triggers subagent spawning ──────────
  const testSessionKey = "test:dm:test-user";
  const testChannelId = "test-user";

  const testMessage = [
    "Please use the subagent tool to spawn exactly ONE subagent with this task:",
    '"Tell me 3 interesting facts about the number 42. Be concise."',
    'Use label "facts-42".',
    "After spawning, respond with a short confirmation that you spawned it.",
  ].join(" ");

  console.log(`📩 [USER] ${testMessage}\n`);
  console.log("--- Sending to agent... ---\n");

  const response = await agent.handleMessage(
    {
      text: testMessage,
      sessionKey: testSessionKey,
      channelId: testChannelId,
      userId: "test-user",
      userName: "TestUser",
      isGroup: false,
    },
    {
      onThinking: () => console.log("🤔 Agent thinking..."),
      onToolStart: (name, meta) => console.log(`🔧 Tool start: ${name}${meta ? ` (${meta})` : ""}`),
      onToolEnd: (name, info) => {
        const parts = [`⏱️  Tool end: ${name} (${info.durationMs}ms)`];
        if (info.error) parts.push(`❌ ${info.error}`);
        if (info.preview) parts.push(`📋 ${info.preview}`);
        console.log(parts.join(" "));
      },
    },
  );

  console.log(`\n--- Parent agent initial response ---`);
  console.log(`💬 ${response?.text?.slice(0, 500) || "(no response)"}\n`);

  // Wait for subagent(s) to finish
  console.log("⏳ Waiting up to 120s for subagent completion...\n");
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    const registry = agent.getSubagentRegistry();
    const runs = registry.listForSession(testSessionKey);
    const active = runs.filter((r) => r.status === "running").length;
    if (runs.length > 0 && active === 0) {
      console.log("✅ All subagent runs completed.");
      break;
    }
    await new Promise((r) => setTimeout(r, 2000));
  }

  // Wait for all pending announce→parent response cycles to finish
  if (pendingAnnounces.length > 0) {
    console.log(`⏳ Waiting for ${pendingAnnounces.length} announce(s) to deliver...\n`);
    await Promise.allSettled(pendingAnnounces);
    console.log("✅ All announces delivered.\n");
  }

  // Final status
  const registry = agent.getSubagentRegistry();
  const allRuns = registry.listForSession(testSessionKey);
  console.log("=== Final Registry State ===");
  for (const run of allRuns) {
    console.log(`  runId:  ${run.runId}`);
    console.log(`  label:  ${run.label || "(none)"}`);
    console.log(`  status: ${run.status}`);
    console.log(`  depth:  ${run.depth}`);
    console.log(`  result: ${(run.result || "").slice(0, 300)}`);
    console.log();
  }

  console.log(`=== Announcements: ${announcements.length} ===`);
  for (const a of announcements) {
    console.log(`  [${a.status}] ${a.label || "?"}`);
    console.log(`    Subagent result: ${a.result.slice(0, 200)}`);
    if (a.parentResponse) {
      console.log(`    Parent response: ${a.parentResponse.slice(0, 300)}`);
    }
    console.log();
  }

  console.log("=== Test complete ===");
  process.exit(0);
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
