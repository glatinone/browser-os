import type { ChallengeKind, Observation } from '@browser-os/protocol';
import type { NodeTable } from './join.js';
import { collapse } from './normalize.js';
import { isVisible } from './visibility.js';

export const IDP_HOSTS = [
  'login.microsoftonline.com',
  'login.live.com',
  'accounts.google.com',
  '*.okta.com',
  '*.auth0.com',
  '*.onelogin.com',
  'idp.*',
  'sso.*',
];

const CAPTCHA_SRC_RE = /recaptcha|hcaptcha|turnstile|challenges\.cloudflare\.com|arkoselabs|funcaptcha|captcha/i;
const CAPTCHA_ATTR_RE = /captcha/i;
const MFA_AUTOCOMPLETE_RE = /one-time-code/i;
const MFA_ATTR_RE = /otp|one.?time|2fa|mfa|verification.?code|security.?code/i;
const MFA_TEXT_RE = /approve sign.?in|enter (the )?code|authenticator/i;
const PASSKEY_RE = /passkey|security key|use your (face|fingerprint)/i;
const CONSENT_RE = /wants to access|permissions requested|grant access/i;

export function isIdpHost(host: string): boolean {
  const normalized = host.toLowerCase().trim();
  if (!normalized) return false;
  for (const entry of IDP_HOSTS) {
    if (entry.startsWith('*.')) {
      const base = entry.slice(2).toLowerCase();
      if (normalized === base || normalized.endsWith(`.${base}`)) return true;
    } else if (entry.endsWith('.*')) {
      const prefix = entry.slice(0, -2).toLowerCase();
      if (normalized === prefix || normalized.startsWith(`${prefix}.`)) return true;
    } else if (normalized === entry.toLowerCase()) {
      return true;
    }
  }
  return false;
}

export function detectChallenge(observation: Observation, table: NodeTable): ChallengeKind | null {
  const host = safeHost(observation.url);
  const onIdp = isIdpHost(host);
  const pageText = challengeText(observation, table);

  if (
    table.frames.some((frame) => CAPTCHA_SRC_RE.test(frame.url ?? '')) ||
    table.rows.some(
      (row) =>
        isVisible(row, table) &&
        CAPTCHA_ATTR_RE.test(
          `${row.attrs.id ?? ''} ${row.attrs.class ?? ''} ${row.attrs.name ?? ''} ${row.ax?.name ?? ''}`,
        ),
    )
  )
    return 'captcha';

  const mfaInput = table.rows.some(
    (row) =>
      row.tag === 'input' &&
      isVisible(row, table) &&
      (MFA_AUTOCOMPLETE_RE.test(row.attrs.autocomplete ?? '') ||
        MFA_ATTR_RE.test(`${row.attrs.name ?? ''} ${row.attrs.id ?? ''} ${row.attrs['aria-label'] ?? ''}`)),
  );
  if (mfaInput || (onIdp && MFA_TEXT_RE.test(pageText))) return 'mfa';
  if (onIdp && PASSKEY_RE.test(pageText)) return 'passkey';
  if (onIdp && CONSENT_RE.test(pageText)) return 'consent';
  if (
    table.rows.some(
      (row) => row.tag === 'input' && row.attrs.type?.toLowerCase() === 'password' && isVisible(row, table),
    ) ||
    onIdp
  )
    return 'login';
  return null;
}

function challengeText(observation: Observation, table: NodeTable): string {
  const blocks =
    observation.text.length > 0
      ? observation.text.map((block) => block.text)
      : table.texts
          .map((text) => {
            const row = table.rows.find((candidate) => candidate.idx === text.parentIdx);
            return row && isVisible(row, table) ? collapse(text.text ?? '') : '';
          })
          .filter(Boolean);
  return [observation.title, ...blocks].filter(Boolean).join('\n');
}

function safeHost(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return '';
  }
}
