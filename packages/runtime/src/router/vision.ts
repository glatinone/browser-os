// Vision tier (action-router §5 tier 4; P7-04 requirement 3).
//
// The `VisionResolver` interface itself lives in `types.ts` (it is part of the
// router's constructor port set, so it must not move). This file ships the MVP
// implementation only: a resolver that answers "no decision" and — critically —
// records no `action.tier` attempt, so a router that awaits it stays byte-for-byte
// identical to one that skips the tier. MVP never calls a vision model, and
// SECURITY.md §9 forbids sending a screenshot of a challenge page to any model.

import type { IndexEntry } from '@browser-os/protocol';
import type { VisionResolver } from './types.js';

/**
 * Tier 4 placeholder. Returns `null` without touching the network, the page, or
 * the LLM budget, and without emitting an attempt: a tier that did nothing must
 * not show up in `ActionResult.attempts`.
 *
 * Phase 11 replaces this with a screenshot-backed resolver behind
 * `policy.tiers.vision` (default `false`), never enabled for challenge pages.
 */
export class NullVisionResolver implements VisionResolver {
  async resolve(): Promise<IndexEntry | null> {
    return null;
  }
}
