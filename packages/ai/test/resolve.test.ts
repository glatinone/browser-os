import { describe, expect, it } from 'vitest';
import { FakeModelProvider } from '../src/fake-provider.js';
import { buildResolvePrompt } from '../src/prompts/resolve-target.js';
import { resolveWithModel } from '../src/resolve.js';

const candidate = {
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
});
