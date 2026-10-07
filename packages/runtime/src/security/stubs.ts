import type { HumanAnswer, PermissionDecision, PermissionRequest, Policy, RiskLevel } from '@browser-os/protocol';
import type { HumanGate, PermissionGate, RiskClassifier, RiskResult } from './interfaces.js';

/**
 * Placeholder classifier: reports `low` for everything. Phase 9 replaces it
 * without touching the interface, which is the whole point of shipping it as a
 * stub — the router can be built and tested against a fixed risk today.
 */
export class StaticRiskClassifier implements RiskClassifier {
  classify(): RiskResult {
    return { risk: 'low', reasons: ['stub risk classifier reports low unconditionally'] };
  }
}

/**
 * Consults `policy`, honouring the site override (`first match wins`) and the
 * per-risk map, then auto-rejects `confirm`: with no human wired up in stub
 * mode, asking for a confirmation nobody can answer would hang the run.
 */
export class PolicyPermissionGate implements PermissionGate {
  decide(risk: RiskResult, policy: Policy, origin: string): 'allow' | 'confirm' | 'deny' {
    const site = policy.sites.find((entry) => originMatches(entry.originPattern, origin));
    if (site?.access === 'deny') return 'deny';

    const decision: PermissionDecision | undefined = site?.risk?.[risk.risk] ?? policy.risk[risk.risk];
    if (decision === 'deny') return 'deny';
    if (decision === 'confirm') return 'deny'; // stub mode: nobody to ask
    return 'allow';
  }

  async requestConfirmation(_request: PermissionRequest): Promise<'approve' | 'reject'> {
    return 'reject';
  }
}

/** Never pauses: the run stops immediately (action-router §3, human tier off). */
export class RejectingHumanGate implements HumanGate {
  async pause(_request: Parameters<HumanGate['pause']>[0]): Promise<HumanAnswer> {
    return { choice: 'abort' };
  }
}

/** Exact origin, or a `*.example.com` wildcard that also covers the bare domain. */
function originMatches(pattern: string, origin: string): boolean {
  if (pattern === origin) return true;
  if (!pattern.startsWith('*.')) return false;
  const suffix = pattern.slice(1); // ".example.com"
  return origin.endsWith(suffix) && origin.length > suffix.length;
}
