import type { ExecutionContext, Observation, ObservationIndex, Policy, ResolvedTarget, Tier, IndexEntry, ElementLocator } from '@browser-os/protocol';
import type { PageDriver } from '@browser-os/browser';
import { BosError } from '../errors.js';
import { Resolution, toResolvedTarget } from './types.js';
import { DEFAULT_ROUTER_CONSTANTS } from './constants.js';

export async function resolveRefTarget(
  target: { kind: 'ref'; ref: string; observationId: string },
  ctx: ExecutionContext,
  attempts: any[],
  driver: any,
  observer: any
): Promise<ResolvedTarget> {
  const idx = observer.index(target.observationId);
  if (!idx) {
    throw new BosError('STALE_REF', `Observation ${target.observationId} not found`);
  }

  const entry = idx.entries.get(target.ref);
  if (!entry) {
    throw new BosError('TARGET_NOT_FOUND', `Ref ${target.ref} not found in observation ${target.observationId}`);
  }

  const element = {
    ref: target.ref,
    role: entry.locator.role,
    name: entry.locator.name,
  };

  return {
    backendNodeId: entry.backendNodeId,
    cdpFrameId: entry.cdpFrameId,
    locator: entry.locator,
    role: element.role,
    name: element.name,
  };
}