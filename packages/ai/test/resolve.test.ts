import type { SemanticElement } from '@browser-os/protocol';
import { MASKED_VALUE } from '@browser-os/protocol';
import { describe, expect, it } from 'vitest';
import { FakeModelProvider } from '../src/fake-provider.js';
import { buildResolvePrompt } from '../src/prompts/resolve-target.js';
import { resolveWithModel } from '../src/resolve.js';

/** Never given to the prompt builder; its absence from the request is the assertion. */
const RAW_SECRET = 'hunter2';

const candidate: SemanticElement = {
  ref: 'e1',
  role: 'textbox',
  name: 'Search',
  tag: 'input',
  state: { editable: true },
  inViewport: true,
  rect: null,
  frame: 'f0',
  context: [],
};

function input(candidates: SemanticElement[]) {
  return {
    actionType: 'fill',
    intent: 'the search box',
    url: 'https://example.test/',
    title: 'Example',
    dialogs: [],
    candidates,
  };
}

describe('resolve-target prompt and validation', () => {
  it('builds the untrusted-data prompt and schema contract', () => {
    const request = buildResolvePrompt({
      actionType: 'fill',
      intent: 'the search box',
      url: 'https://example.test/',
      title: 'Example',
      dialogs: [],
      candidates: [candidate],
    });
    expect(request.system).toContain('untrusted data');
    expect(request.messages[0]?.content).toEqual(
      expect.arrayContaining([expect.objectContaining({ text: expect.stringContaining('e1 textbox "Search"') })]),
    );
    expect(request.jsonSchema).toBeDefined();
    expect(request.maxOutputTokens).toBe(100);
    expect(request.temperature).toBe(0);
  });

  it('accepts only a candidate ref and retries invalid model output once', async () => {
    let calls = 0;
    const provider = new FakeModelProvider({
      responder: () => {
        calls += 1;
        return calls === 1 ? '{"ref":"not-a-ref","confidence":1}' : { ref: 'e1', confidence: 0.91 };
      },
    });
    const result = await resolveWithModel(provider, {
      actionType: 'fill',
      intent: 'search',
      url: '',
      title: '',
      dialogs: [],
      candidates: [candidate],
    });
    expect(result).toMatchObject({ ref: 'e1', confidence: 0.91, retried: true });
    expect(provider.calls).toBe(2);
  });

  it('rejects invalid output twice with LLM_INVALID_OUTPUT', async () => {
    const provider = new FakeModelProvider({ responder: '{"ref":"e1"}' });
    await expect(
      resolveWithModel(provider, {
        actionType: 'click',
        intent: 'button',
        url: '',
        title: '',
        dialogs: [],
        candidates: [candidate],
      }),
    ).rejects.toMatchObject({ code: 'LLM_INVALID_OUTPUT' });
    expect(provider.calls).toBe(2);
  });

  it('echoes non-sensitive values verbatim, so masking has to happen upstream', () => {
    const email = {
      ...candidate,
      ref: 'e2',
      name: 'Email',
      value: 'alice@example.com',
    };
    const serialized = JSON.stringify(buildResolvePrompt({ ...input([email]) }));
    expect(serialized).toContain('alice@example.com');
  });

  it('keeps a masked password masked and never carries the raw secret', () => {
    const password = {
      ...candidate,
      ref: 'e7',
      name: 'Password',
      placeholder: 'Your password',
      value: MASKED_VALUE,
    };
    const serialized = JSON.stringify(buildResolvePrompt({ ...input([password]) }));
    // The contract: dom masks before handing elements over, and `ai` passes the
    // mask through untouched rather than dropping or rewriting it.
    expect(serialized).toContain(MASKED_VALUE);
    // The raw secret exists only in the fixture, never in anything fed to the
    // prompt builder, so it must not appear anywhere in the request.
    expect(serialized).not.toContain(RAW_SECRET);
  });

  it('stays within the E1 budget of 1500 estimated tokens for 30 candidates', () => {
    const candidates = Array.from({ length: 30 }, (_, i) => ({
      ...candidate,
      ref: `e${i + 1}`,
      name: `Field ${i + 1}`,
      placeholder: `Placeholder ${i + 1}`,
      context: ['Main', 'Form'],
    }));
    const request = buildResolvePrompt(input(candidates));

    // Same estimator the Fake provider uses: ceil(chars / 4).
    const promptChars =
      request.system.length +
      request.messages.reduce((size, message) => {
        if (typeof message.content === 'string') return size + message.content.length;
        return size + message.content.reduce((n, part) => n + part.text.length, 0);
      }, 0);
    const estimatedTokens = Math.ceil(promptChars / 4);

    expect(estimatedTokens).toBeLessThanOrEqual(1500);
  });
});
