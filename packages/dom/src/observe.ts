import type { RawCapture } from './capture.js';
import { buildObservation, type SemanticOptions } from './semantic.js';

export type { ObservationIndex } from '@browser-os/protocol';

export function observe(raw: RawCapture, meta: SemanticOptions = {}): ReturnType<typeof buildObservation> {
  return buildObservation(raw, meta);
}
