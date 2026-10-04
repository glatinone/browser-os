// The default Clock. Tasks that must be testable take a Clock; this is what the
// runtime uses outside tests (data-models §8).

import type { Clock } from './context.js';

export const systemClock: Clock = {
  now: () => Date.now(),
};
