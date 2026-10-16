// P7-07 — config loading (protocol §6).
//
// `<BOS_HOME>/config.json` is zod-validated with every field optional; a
// missing or partial file resolves to defaults here. An existing file that
// does not validate is an `INVALID_REQUEST` — silent defaults over a typo
// would move policy without anyone noticing.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { BosError, type Config, ConfigSchema } from '@browser-os/protocol';

export function defaultConfig(): Config {
  return ConfigSchema.parse({});
}

/**
 * Read `<bosHome>/config.json`. The file's values are merged **raw** into the
 * schema defaults: `ConfigSchema` applies a block's whole default when the
 * block is absent, so merging pre-parsed blocks would replace the default
 * budgets with a policy block that set only `risk`.
 */
export function loadConfig(bosHome: string): Config {
  return parseConfig(readConfigFile(join(bosHome, 'config.json')));
}

export function parseConfig(raw: unknown): Config {
  const result = ConfigSchema.safeParse(raw);
  if (!result.success) {
    throw new BosError('INVALID_REQUEST', 'config.json is invalid', {
      details: { issues: result.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`) },
    });
  }
  return result.data;
}

function readConfigFile(path: string): unknown {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    return {};
  }
  try {
    return JSON.parse(text) as unknown;
  } catch (error) {
    throw new BosError('INVALID_REQUEST', `${path} is not valid JSON`, {
      cause: error instanceof Error ? error : undefined,
    });
  }
}
