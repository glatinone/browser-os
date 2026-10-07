import { DEFAULT_POLICY, type Policy } from '@browser-os/protocol';
import { describe, expect, it } from 'vitest';
import type { RiskResult } from '../src/security/interfaces.js';
import { PolicyPermissionGate, RejectingHumanGate, StaticRiskClassifier } from '../src/security/stubs.js';

const low: RiskResult = { risk: 'low', reasons: ['stub'] };
const high: RiskResult = { risk: 'high', reasons: ['delete button'] };

function policy(overrides: Partial<Policy> = {}): Policy {
  return { ...DEFAULT_POLICY, ...overrides };
}

describe('security stubs', () => {
  it('reports low risk for everything', () => {
    const classifier = new StaticRiskClassifier();
    const result = classifier.classify();
    expect(result.risk).toBe('low');
    expect(Array.isArray(result.reasons)).toBe(true);
    expect(result.reasons.length).toBeGreaterThan(0);
  });

  it('follows the per-risk policy map', () => {
    const gate = new PolicyPermissionGate();
    const p = policy({ risk: { low: 'allow', medium: 'confirm', high: 'deny' } });
    expect(gate.decide(low, p, 'https://a.test')).toBe('allow');
    expect(gate.decide({ risk: 'medium', reasons: [] }, p, 'https://a.test')).toBe('deny');
    expect(gate.decide(high, p, 'https://a.test')).toBe('deny');
  });

  it('auto-rejects confirm in stub mode because nobody can answer it', async () => {
    const gate = new PolicyPermissionGate();
    const p = policy({ risk: { low: 'allow', medium: 'allow', high: 'confirm' } });
    expect(gate.decide(high, p, 'https://a.test')).toBe('deny');
    await expect(gate.requestConfirmation({} as never)).resolves.toBe('reject');
  });

  it('honours a site override, including the wildcard form', () => {
    const gate = new PolicyPermissionGate();
    const p = policy({
      risk: { low: 'allow', medium: 'allow', high: 'confirm' },
      sites: [
        { originPattern: '*.example.com', risk: { low: 'deny' } },
        { originPattern: 'https://bank.test', access: 'deny' },
      ],
    });
    // First match wins: the wildcard denies low risk on its own subdomains only.
    expect(gate.decide(low, p, 'https://shop.example.com')).toBe('deny');
    expect(gate.decide(low, p, 'https://example.com')).toBe('allow');
    expect(gate.decide(low, p, 'https://notexample.com')).toBe('allow');

    // access: 'deny' refuses the origin outright, whatever the risk says.
    expect(gate.decide(low, p, 'https://bank.test')).toBe('deny');
  });

  it('aborts immediately instead of pausing', async () => {
    const gate = new RejectingHumanGate();
    await expect(
      gate.pause({ sessionId: 's', taskId: null, reason: 'ambiguous', message: 'pick one' }),
    ).resolves.toEqual({ choice: 'abort' });
  });
});
