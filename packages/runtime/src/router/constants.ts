import type { RouterConstants } from './types.js';

/**
 * action-router §3.1 tuning defaults. One object so P10-02 can sweep them and
 * so a router construction never depends on module-load side effects.
 */
export const DEFAULT_ROUTER_CONSTANTS: RouterConstants = {
  lexicalAccept: 0.75,
  lexicalMargin: 0.15,
  matchAccept: 0.7,
  matchMargin: 0.1,
  llmCandidates: 5,
  llmMinConfidence: 0.72,
  probeTimeoutMs: 800,
  probeIntervalMs: 50,
  settleQuietMs: 400,
  settleMaxMs: 2000,
  cacheMaxConsecutiveMisses: 3,
};

export function mergeConstants(overrides?: Partial<RouterConstants>): RouterConstants {
  return { ...DEFAULT_ROUTER_CONSTANTS, ...overrides };
}
