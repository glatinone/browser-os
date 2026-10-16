// P7-07 — config loading (protocol §6): defaults, partial merge, hard failures.

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { BosError } from '@browser-os/protocol';
import { afterAll, describe, expect, it } from 'vitest';
import { defaultConfig, loadConfig, parseConfig } from '../src/config/load-config.js';

/**
 * Card tests: "config loading with defaults" (docs/tasks/phase-07-router-and-tasks.md
 * P7-07). A missing or partial file resolves to defaults; a file that exists but
 * does not validate is INVALID_REQUEST — silent defaults over a typo would move
 * policy without anyone noticing.
 */

const homes: string[] = [];
function tempHome(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'bos-cfg-'));
  homes.push(dir);
  return dir;
}

afterAll(() => {
  for (const dir of homes) rmSync(dir, { recursive: true, force: true });
});

describe('loadConfig (P7-07)', () => {
  it('a missing config.json resolves to the schema defaults', () => {
    const config = loadConfig(tempHome());
    expect(config).toEqual(defaultConfig());
    expect(config.defaultProfile).toBe('default');
    expect(config.defaultChannel).toBe('chrome');
    expect(config.policy.budgets.maxLlmCallsPerAction).toBeGreaterThan(0);
    expect(config.models.fast).toBeNull();
  });

  it('a partial file merges raw blocks into the defaults, not over them', () => {
    const home = tempHome();
    // Setting only one budget must not drop the sibling budgets nor the rest
    // of the policy block (the whole block's defaults would otherwise be lost).
    writeFileSync(
      path.join(home, 'config.json'),
      JSON.stringify({ policy: { budgets: { maxLlmCallsPerAction: 3 } } }),
      'utf8',
    );
    const config = loadConfig(home);
    expect(config.policy.budgets.maxLlmCallsPerAction).toBe(3);
    expect(config.policy.budgets.maxLlmCallsPerTask).toBe(defaultConfig().policy.budgets.maxLlmCallsPerTask);
    expect(config.policy.budgets.actionTimeoutMs).toBe(defaultConfig().policy.budgets.actionTimeoutMs);
    expect(config.policy.sites).toEqual(defaultConfig().policy.sites);
    expect(config.policy.uploads).toEqual(defaultConfig().policy.uploads);
    expect(config.defaultProfile).toBe('default');
  });

  it('top-level fields override their defaults', () => {
    const home = tempHome();
    writeFileSync(path.join(home, 'config.json'), JSON.stringify({ defaultProfile: 'work', retentionDays: 7 }), 'utf8');
    const config = loadConfig(home);
    expect(config.defaultProfile).toBe('work');
    expect(config.retentionDays).toBe(7);
  });

  it('an invalid config.json is INVALID_REQUEST naming the offending path', () => {
    const home = tempHome();
    writeFileSync(path.join(home, 'config.json'), JSON.stringify({ retentionDays: 'forever' }), 'utf8');
    const before = defaultConfig();
    expect(() => loadConfig(home)).toThrowError(BosError);
    try {
      loadConfig(home);
    } catch (error) {
      const err = error as BosError;
      expect(err.code).toBe('INVALID_REQUEST');
      const details = err.details as { issues?: string[] };
      expect(details.issues?.[0]).toContain('retentionDays');
    }
    expect(defaultConfig()).toEqual(before);
  });

  it('a config.json that is not JSON is INVALID_REQUEST', () => {
    const home = tempHome();
    writeFileSync(path.join(home, 'config.json'), '{ not json', 'utf8');
    try {
      loadConfig(home);
      expect.unreachable('loadConfig accepted a malformed file');
    } catch (error) {
      expect((error as BosError).code).toBe('INVALID_REQUEST');
    }
  });

  it('parseConfig validates model provider names', () => {
    expect(() => parseConfig({ models: { fast: { provider: 'carrier-pigeon' } } })).toThrowError(BosError);
    const withFake = parseConfig({ models: { fast: { provider: 'fake', latencyMs: 5 } } });
    expect(withFake.models.fast).toMatchObject({ provider: 'fake', latencyMs: 5 });
  });
});
