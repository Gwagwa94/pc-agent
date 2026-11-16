// Shared mutable state for the Dual-Brain agent
export const state = {
  recentLogs: [] as string[],
  screenDimensions: { width: 1920, height: 1080 },
  lastSnapshotTimestamp: 0,
  isAgentBusy: false,
  currentlyLoadedModel: '',
};
