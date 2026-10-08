import type { ElementLocator, IndexEntry, ResolvedTarget, ExecutionContext } from '@browser-os/protocol';
import type { PageDriver } from '@browser-os/browser';
import { BosError } from '../errors.js';
import { DEFAULT_ROUTER_CONSTANTS } from './constants.js';

export interface ProbeCandidate {
  backendNodeId: number;
  cdpFrameId: string;
  frameId: string;
  locator: any;
  role: string;
  name: string;
  rect: { x: number; y: number; w: number; h: number } | null;
  disabled: boolean;
}

export function matchLocator(
  obs: any,
  locator: any,
  constants: typeof DEFAULT_ROUTER_CONSTANTS
): Array<{ entry: IndexEntry; score: number }> {
  // Fingerprint matching - dom-intelligence §8.4
  const candidates = obs.elements
    .map((el: any, idx: number) => {
      let score = 0;
      const loc = locator;

      // Role match (high weight)
      if (el.role === loc.role) score += 0.4;

      // Name match (high weight) - exact then contains
      if (loc.name && el.name) {
        if (el.name === loc.name) score += 0.3;
        else if (el.name.includes(loc.name) || loc.name.includes(el.name)) score += 0.15;
      }

      // Tag match
      if (el.tag === loc.tag) score += 0.1;

      // Stable attributes match
      if (loc.attrs) {
        for (const [key, value] of Object.entries(loc.attrs)) {
          if (el.attrs && el.attrs[key] === value) score += 0.05;
        }
      }

      // Context match
      if (loc.context && loc.context.length > 0) {
        const contextMatch = loc.context.some((c: string) =>
          el.context?.includes(c)
        );
        if (contextMatch) score += 0.1;
      }

      // CSS path match (lower weight, used as tiebreaker)
      if (loc.cssPath && el.cssPath === loc.cssPath) score += 0.05;

      return {
        entry: {
          backendNodeId: idx,
          frameId: el.frame,
          cdpFrameId: el.cdpFrameId ?? '',
          locator: loc,
        },
        score,
        element: { ref: `e${idx}`, role: el.role, name: el.name },
      };
    })
    .filter((c: any) => c.score > 0)
    .sort((a: any, b: any) => b.score - a.score);

  return candidates;
}

export async function tryResolveLocator(
  locator: any,
  tierLabel: 'cache' | 'locator',
  attempts: any[],
  ctx: any,
  driver: any,
  observer: any,
  constants: typeof DEFAULT_ROUTER_CONSTANTS
): Promise<any | null> {
  // Stage 1: Probe (no full observation) - only for main frame
  if (locator.framePath.length === 0) {
    const deadline = Date.now() + constants.probeTimeoutMs;
    
    while (Date.now() < deadline) {
      try {
        const candidates = await probeLocator(driver, locator, ctx);
        if (candidates.length === 1) {
          const score = await verifyIdentity(driver, candidates[0], locator);
          if (score >= DEFAULT_ROUTER_CONSTANTS.matchAccept) {
            return {
              tier: tierLabel,
              entry: candidates[0].entry,
              element: candidates[0].element,
              disabled: candidates[0].disabled,
            };
          }
        }
        if (candidates.length > 1) {
          break; // ambiguous → go to full match
        }
      } catch {
        // probe failed, continue waiting
      }
      await new Promise(r => setTimeout(r, DEFAULT_ROUTER_CONSTANTS.probeIntervalMs));
    }
  }

  // Stage 2: Full observation + fingerprint scoring
  const obs = await driver.capture();
  const scored = matchLocator(obs, locator, DEFAULT_ROUTER_CONSTANTS);
  
  if (scored.length > 0) {
    const best = scored[0];
    const secondBest = scored[1]?.score ?? 0;
    
    if (best.score >= DEFAULT_ROUTER_CONSTANTS.matchAccept && 
        best.score - secondBest >= DEFAULT_ROUTER_CONSTANTS.matchMargin) {
      attempts.push({ tier: 'cache', ok: true, score: best.score, reason: 'matched' });
      return {
        tier: tierLabel,
        entry: best.entry,
        element: best.element,
        disabled: false,
      };
    }
  }

  attempts.push({
    tier: 'cache',
    ok: false,
    reason: scored.length ? 'TARGET_AMBIGUOUS' : 'TARGET_NOT_FOUND',
  });
  return null;
}

async function probeLocator(driver: any, locator: any, ctx: any): Promise<any[]> {
  // Probe using DOM helper - ≤ 4 CDP round trips
  // dom-intelligence §8.3
  const frameId = ctx.pageId; // main frame
  const candidates = await driver.probeLocator(locator, frameId);
  return candidates;
}

async function verifyIdentity(driver: any, candidate: any, locator: any): Promise<number> {
  // Verify identity against locator - dom-intelligence §8.4
  // Returns match score 0-1
  return 0.8; // stub
}