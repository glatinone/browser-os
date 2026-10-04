// Sortable, dependency-free identifiers (data-models §1).
//
// Format: `${prefix}_${10 chars base32 time}${16 chars base32 random}`.
// Crockford base32 (no I, L, O, U) keeps ids readable and, because the time part
// is fixed-width and first, any id created in a later millisecond sorts after
// every id created earlier — a plain string sort is a creation-time sort.

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const TIME_CHARS = 10;
const RANDOM_CHARS = 16;
const RANDOM_BYTES = RANDOM_CHARS;

export type IdPrefix = 'prf' | 'ses' | 'pg' | 'obs' | 'tsk' | 'trj' | 'run' | 'perm' | 'req';

export const ID_PREFIXES = [
  'prf',
  'ses',
  'pg',
  'obs',
  'tsk',
  'trj',
  'run',
  'perm',
  'req',
] as const satisfies readonly IdPrefix[];

function encodeTime(ms: number): string {
  let remaining = Math.floor(ms);
  let out = '';
  for (let i = 0; i < TIME_CHARS; i += 1) {
    out = CROCKFORD[remaining % 32] + out;
    remaining = Math.floor(remaining / 32);
  }
  return out;
}

function encodeRandom(): string {
  const bytes = new Uint8Array(RANDOM_BYTES);
  crypto.getRandomValues(bytes);
  let out = '';
  // 256 is divisible by 32, so the modulo introduces no bias.
  for (const byte of bytes) out += CROCKFORD[byte % 32];
  return out;
}

/** Returns `${prefix}_${26 chars}`: 10 chars base32 time + 16 chars base32 random. Sortable by creation time. */
export function newId(prefix: IdPrefix): string {
  return `${prefix}_${encodeTime(Date.now())}${encodeRandom()}`;
}
