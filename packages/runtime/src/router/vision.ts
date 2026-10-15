// Tier 4, vision (action-router §2 row 4). Post-MVP: the interface exists so the
// ladder has a slot to call, and the MVP implementation never resolves anything.

import type { IndexEntry, Observation, ObservationIndex, TierAttempt } from '@browser-os/protocol';

export interface ResolveVisionInput {
  observation: Observation;
  index: ObservationIndex;
  actionType: string;
  intent: string;
  attempts: TierAttempt[];
}

/**
 * §2 tier 4 is post-MVP. The null resolver records no attempt at all: the tier
 * does not exist for the MVP, so it must be invisible in the attempt log.
 * The interface (§3.1 VisionResolver) is owned here so P10+ can replace it.
 */
export async function resolveWithVision(_input: {
  observation: Observation;
  index: ObservationIndex;
  attempts: TierAttempt[];
}): Promise<IndexEntry | null> {
  return null;
}
