import { afterEach, describe, expect, it, vi } from 'vitest';
import { ID_PREFIXES, type IdPrefix, newId } from '../src/ids.js';

const BODY_RE = '[0-9A-HJKMNP-TV-Z]{26}';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('newId', () => {
  it.each(ID_PREFIXES)('returns `%s_` + 26 Crockford base32 chars', (prefix: IdPrefix) => {
    const id = newId(prefix);
    // Prefix lengths differ (pg, ses, perm), so the pattern is built per prefix —
    // the card gives the `ses_` form explicitly.
    expect(id).toMatch(new RegExp(`^${prefix}_${BODY_RE}$`));
    expect(id.startsWith(`${prefix}_`)).toBe(true);
    expect(id).toHaveLength(prefix.length + 1 + 26);
  });

  it('generates 10k unique ids', () => {
    const ids = new Set<string>();
    for (let i = 0; i < 10_000; i += 1) ids.add(newId('ses'));
    expect(ids.size).toBe(10_000);
  });

  it('never uses the Crockford-ambiguous letters I, L, O and U', () => {
    let body = '';
    for (let i = 0; i < 500; i += 1) body += newId('obs').slice(4);
    expect(body).not.toMatch(/[ILOU]/);
  });

  it('sorts lexicographically by creation millisecond', () => {
    const now = vi.spyOn(Date, 'now');
    now.mockReturnValue(1_700_000_000_000);
    const first = newId('run');
    now.mockReturnValue(1_700_000_000_001);
    const second = newId('run');
    now.mockReturnValue(1_700_000_000_002);
    const third = newId('run');

    expect([third, first, second].sort()).toEqual([first, second, third]);
    expect(first < second).toBe(true);
    expect(second < third).toBe(true);
  });

  it('keeps ordering across a full year of clock values', () => {
    const now = vi.spyOn(Date, 'now');
    const base = 1_700_000_000_000;
    const ids: string[] = [];
    for (let day = 0; day < 365; day += 1) {
      now.mockReturnValue(base + day * 86_400_000);
      ids.push(newId('tsk'));
    }
    expect([...ids].sort()).toEqual(ids);
  });
});
