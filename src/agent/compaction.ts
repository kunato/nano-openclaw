const COMPACTION_RESERVE_TOKENS = 20_000;

/**
 * Ensure the Pi SDK's SettingsManager has a sufficient compaction reserve.
 * Mirrors OpenClaw's `ensurePiCompactionReserveTokens` from pi-settings.ts.
 */
export function ensureCompactionReserveTokens(settingsManager: {
  getCompactionReserveTokens: () => number;
  applyOverrides: (overrides: { compaction: { reserveTokens: number } }) => void;
}): void {
  try {
    const current = settingsManager.getCompactionReserveTokens();
    if (current < COMPACTION_RESERVE_TOKENS) {
      settingsManager.applyOverrides({
        compaction: { reserveTokens: COMPACTION_RESERVE_TOKENS },
      });
      console.log(
        `[agent] Set compaction reserveTokens: ${current} → ${COMPACTION_RESERVE_TOKENS}`,
      );
    }
  } catch {
    // SettingsManager may not support these methods in all Pi SDK versions
  }
}
