import type { ElementLocator, Observation, ObservationIndex, SemanticElement } from '@browser-os/protocol';
import { describe, expect, it } from 'vitest';
import { matchLocator } from '../src/locator.js';

interface Candidate {
  ref: string;
  role: string;
  name: string;
  tag?: string;
  attrs?: ElementLocator['attrs'];
  context?: string[];
  cssPath?: string;
  ordinal?: number;
}

function locator(candidate: Candidate): ElementLocator {
  return {
    v: 1,
    role: candidate.role,
    name: candidate.name,
    nameIsDynamic: false,
    tag: candidate.tag ?? 'button',
    attrs: candidate.attrs ?? {},
    context: candidate.context ?? ['Main'],
    cssPath: candidate.cssPath ?? 'main > button:nth-of-type(1)',
    framePath: [],
    ordinal: candidate.ordinal ?? 0,
  };
}

function observed(candidates: Candidate[]): { observation: Observation; index: ObservationIndex } {
  const elements = candidates.map(
    (candidate): SemanticElement => ({
      ref: candidate.ref,
      role: candidate.role,
      name: candidate.name,
      tag: candidate.tag ?? 'button',
      state: {},
      inViewport: true,
      rect: { x: 0, y: 0, w: 100, h: 30 },
      frame: 'f0',
      context: candidate.context ?? ['Main'],
    }),
  );
  const entries = new Map(
    candidates.map((candidate) => [
      candidate.ref,
      {
        backendNodeId: 1,
        frameId: 'f0',
        cdpFrameId: 'frame',
        locator: locator(candidate),
      },
    ]),
  );
  return {
    observation: {
      id: 'obs_mutated',
      sessionId: 'test',
      pageId: 'test',
      url: 'https://fixture.test/',
      title: 'Mutation fixture',
      capturedAt: 0,
      frames: [],
      elements,
      text: [],
      dialogs: [],
      challenge: null,
      warnings: [],
      stats: {
        domNodes: elements.length,
        axNodes: elements.length,
        elements: elements.length,
        captureMs: 0,
        buildMs: 0,
        estTokens: 0,
        large: false,
      },
    },
    index: { observationId: 'obs_mutated', pageId: 'test', entries },
  };
}

const BASE: Candidate = {
  ref: 'e1',
  role: 'button',
  name: 'Sign in',
  attrs: { 'data-testid': 'submit-login', name: 'submit' },
  context: ['Account', 'Main'],
  cssPath: 'main > form:nth-of-type(1) > button:nth-of-type(1)',
};

const POSITIVE_CASES: Array<{ name: string; candidate: Candidate }> = [
  { name: 'class names changed', candidate: { ...BASE, attrs: { ...BASE.attrs }, cssPath: BASE.cssPath } },
  {
    name: 'sibling order reversed',
    candidate: { ...BASE, cssPath: 'main > form:nth-of-type(1) > button:nth-of-type(2)' },
  },
  {
    name: 'extra wrapper divs',
    candidate: { ...BASE, cssPath: 'main > div:nth-of-type(1) > form:nth-of-type(1) > button:nth-of-type(1)' },
  },
  {
    name: 'badge count changed',
    candidate: {
      ...BASE,
      name: 'Messages 7',
      role: 'link',
      tag: 'a',
      attrs: { 'data-testid': 'messages-badge' },
      context: ['Main'],
    },
  },
  {
    name: 'unstable ids regenerated',
    candidate: { ...BASE, attrs: { 'data-testid': 'submit-login', name: 'submit' } },
  },
  { name: 'button text case changed', candidate: { ...BASE, name: 'Sign In' } },
  {
    name: 'element moved within the same landmark',
    candidate: { ...BASE, cssPath: 'main > section:nth-of-type(2) > button:nth-of-type(1)' },
  },
];

describe('locator robustness under DOM mutations', () => {
  it.each(POSITIVE_CASES)('keeps the target first with a 0.10 margin when $name', ({ candidate }) => {
    const source = candidate.name === 'Messages 7' ? locator({ ...candidate, name: 'Messages 3' }) : locator(BASE);
    const distractor: Candidate = {
      ref: 'e2',
      role: 'button',
      name: 'Cancel',
      attrs: { name: 'cancel' },
      context: ['Account', 'Main'],
    };
    const { observation, index } = observed([candidate, distractor]);
    const matches = matchLocator(observation, index, source);
    expect(matches[0]?.ref).toBe('e1');
    expect(matches[0]?.score ?? 0).toBeGreaterThanOrEqual(0.7);
    if (matches.length > 1) expect((matches[0]?.score ?? 0) - (matches[1]?.score ?? 0)).toBeGreaterThanOrEqual(0.1);
  });

  it('does not match a removed target above the acceptance threshold', () => {
    const { observation, index } = observed([
      { ref: 'e2', role: 'button', name: 'Create account', attrs: { name: 'register' }, context: ['Account', 'Main'] },
      { ref: 'e3', role: 'link', name: 'Forgot password', attrs: { href: '/forgot' }, context: ['Account', 'Main'] },
    ]);
    const matches = matchLocator(observation, index, locator(BASE));
    expect(matches[0]?.score ?? 0).toBeLessThan(0.7);
  });
});
