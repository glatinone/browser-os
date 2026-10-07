export const DEFAULT_ROUTER_CONSTANTS = {
  lexicalAccept: 0.75,
  lexicalMargin: 0.15,
  matchAccept: 0.70,
  matchMargin: 0.10,
  llmCandidates: 30,
  llmMinConfidence: 0.5,
  probeTimeoutMs: 1500,
  probeIntervalMs: 50,
  settleQuietMs: 100,
  settleMaxMs: 2000,
  cacheMaxConsecutiveMisses: 3,
} as const;

export type RouterConstants = typeof DEFAULT_ROUTER_CONSTANTS;