import type { ChallengeKind, Observation } from '@browser-os/protocol';
import type { NodeTable } from './join.js';

const IDP_HOST =
  /(^|\.)((login\.microsoftonline\.com)|(login\.live\.com)|(accounts\.google\.com)|([^.]+\.(okta|auth0|onelogin)\.com)|(idp\.)|(sso\.))/i;

export function detectChallenge(observation: Observation, table: NodeTable): ChallengeKind | null {
  const host = safeHost(observation.url);
  const text = [
    observation.title,
    ...observation.text.map((block) => block.text),
    ...table.rows.map((row) => `${row.attrs.id ?? ''} ${row.attrs.class ?? ''} ${row.ax?.name ?? ''}`),
  ].join(' ');
  const captcha =
    table.frames.some((frame) =>
      /recaptcha|hcaptcha|turnstile|challenges\.cloudflare\.com|arkoselabs|funcaptcha|captcha/i.test(frame.url),
    ) || /captcha/i.test(text);
  if (captcha) return 'captcha';
  const mfaInput = table.rows.some(
    (row) =>
      row.tag === 'input' &&
      (/one-time-code/i.test(row.attrs.autocomplete ?? '') ||
        /otp|one.?time|2fa|mfa|verification.?code|security.?code/i.test(
          `${row.attrs.name ?? ''} ${row.attrs.id ?? ''} ${row.attrs['aria-label'] ?? ''}`,
        )),
  );
  if (mfaInput || (IDP_HOST.test(host) && /approve sign.?in|enter (the )?code|authenticator/i.test(text))) return 'mfa';
  if (IDP_HOST.test(host) && /passkey|security key|use your (face|fingerprint)/i.test(text)) return 'passkey';
  if (IDP_HOST.test(host) && /wants to access|permissions requested|grant access/i.test(text)) return 'consent';
  if (
    table.rows.some((row) => row.tag === 'input' && row.attrs.type?.toLowerCase() === 'password') ||
    IDP_HOST.test(host)
  )
    return 'login';
  return null;
}

function safeHost(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return '';
  }
}
