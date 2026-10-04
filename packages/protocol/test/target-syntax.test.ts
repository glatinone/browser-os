import { describe, expect, it } from 'vitest';
import { BosError, parseTargetString } from '../src/index.js';

const OBS = 'obs_01M42A92RQSBV852WQDCT86TAJ';

describe('parseTargetString — ref', () => {
  it("turns @e12 into a ref bound to the caller's current observation", () => {
    expect(parseTargetString('@e12', OBS)).toEqual({ kind: 'ref', ref: 'e12', observationId: OBS });
  });

  it('accepts surrounding whitespace', () => {
    expect(parseTargetString('  @e1  ', OBS)).toEqual({ kind: 'ref', ref: 'e1', observationId: OBS });
  });

  it('refuses a ref when the caller has no current observation', () => {
    try {
      parseTargetString('@e12', null);
      throw new Error('should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(BosError);
      expect((error as BosError).code).toBe('INVALID_REQUEST');
      expect((error as BosError).retryable).toBe(false);
      expect((error as BosError).details).toEqual({ target: '@e12' });
    }
  });
});

describe('parseTargetString — query', () => {
  it('parses the documented example', () => {
    expect(parseTargetString('role=button name="Sign in"', OBS)).toEqual({
      kind: 'query',
      role: 'button',
      name: 'Sign in',
    });
  });

  it('parses a single css pair', () => {
    expect(parseTargetString('css=#submit', OBS)).toEqual({ kind: 'query', css: '#submit' });
  });

  it('parses a quoted text pair', () => {
    expect(parseTargetString('text="Next"', OBS)).toEqual({ kind: 'query', text: 'Next' });
  });

  it('parses nth as a non-negative integer', () => {
    expect(parseTargetString('nth=2', OBS)).toEqual({ kind: 'query', nth: 2 });
    expect(parseTargetString('nth=0', OBS)).toEqual({ kind: 'query', nth: 0 });
    expect(parseTargetString('role=link nth=3', OBS)).toEqual({ kind: 'query', role: 'link', nth: 3 });
  });

  it('lets a later duplicate key win', () => {
    expect(parseTargetString('name="first" name="second"', OBS)).toEqual({ kind: 'query', name: 'second' });
  });

  it('keeps a quoted value containing spaces in one pair', () => {
    expect(parseTargetString('name="Ada Lovelace" role=link', OBS)).toEqual({
      kind: 'query',
      name: 'Ada Lovelace',
      role: 'link',
    });
  });

  it('falls back to an intent when a value is empty, negative, non-numeric or unquoted-with-spaces', () => {
    for (const input of ['role=', 'nth=', 'nth=-1', 'nth=abc', 'name=a b', 'name="Sign in']) {
      expect(parseTargetString(input, OBS), input).toEqual({ kind: 'intent', text: input });
    }
  });

  it('falls back to an intent for a malformed pair: no key, or a value quoted on one side only', () => {
    for (const input of ['=x', 'name=a"b"', 'name="a"b']) {
      expect(parseTargetString(input, OBS), input).toEqual({ kind: 'intent', text: input });
    }
  });

  it('treats repeated whitespace as a single separator, so a double space cannot break a query', () => {
    expect(parseTargetString('role=button  name="Sign in"', OBS)).toEqual({
      kind: 'query',
      role: 'button',
      name: 'Sign in',
    });
    expect(parseTargetString('  css=#a  ', OBS)).toEqual({ kind: 'query', css: '#a' });
  });

  it('falls back to an intent for an unknown key or an uppercase key', () => {
    expect(parseTargetString('foo=bar', OBS)).toEqual({ kind: 'intent', text: 'foo=bar' });
    expect(parseTargetString('ROLE=button', OBS)).toEqual({ kind: 'intent', text: 'ROLE=button' });
  });
});

describe('parseTargetString — intent', () => {
  it('treats prose as an intent, untrimmed inside', () => {
    expect(parseTargetString('the search box', OBS)).toEqual({ kind: 'intent', text: 'the search box' });
  });

  it('strips one pair of surrounding quotes from a quoted intent', () => {
    expect(parseTargetString('"the search box"', OBS)).toEqual({ kind: 'intent', text: 'the search box' });
  });

  it('keeps a single leading quote that is not a pair', () => {
    expect(parseTargetString('"the search box', OBS)).toEqual({ kind: 'intent', text: '"the search box' });
    expect(parseTargetString('"', OBS)).toEqual({ kind: 'intent', text: '"' });
  });

  it('treats a lone @ that is not a ref as an intent', () => {
    expect(parseTargetString('@', OBS)).toEqual({ kind: 'intent', text: '@' });
    expect(parseTargetString('@nope', OBS)).toEqual({ kind: 'intent', text: '@nope' });
  });
});

describe('parseTargetString — invalid input', () => {
  it('rejects an empty or whitespace-only target instead of inventing an intent', () => {
    for (const input of ['', '   ', '\t\n']) {
      expect(() => parseTargetString(input, OBS), JSON.stringify(input)).toThrow(BosError);
      try {
        parseTargetString(input, OBS);
      } catch (error) {
        expect((error as BosError).code).toBe('INVALID_REQUEST');
      }
    }
  });

  it('does not need an observation to parse a query or an intent', () => {
    expect(parseTargetString('css=#a', null)).toEqual({ kind: 'query', css: '#a' });
    expect(parseTargetString('anything', null)).toEqual({ kind: 'intent', text: 'anything' });
  });
});
