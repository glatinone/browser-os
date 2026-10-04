import { describe, expect, it } from 'vitest';
import { resolveProfileDir } from '../src/profile-directories.js';
import { BosError } from '@browser-os/protocol';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

describe('resolveProfileDir', () => {
  it('returns a path under BOS_HOME/profiles/<id>', async () => {
    const id = newId();
    const dir = await resolveProfileDir(id);
    expect(dir).toMatch(new RegExp(`profiles[\\\\/]${id}$`));
  });

  it('creates the directory if it does not exist', async () => {
    const id = newId();
    const dir = await resolveProfileDir(id);
    const stat = await fs.stat(dir);
    expect(stat.isDirectory()).toBe(true);
  });

  it('rejects traversal attempts', async () => {
    await expect(resolveProfileDir('../etc')).rejects.toThrow(BosError);
    await expect(resolveProfileDir('../../hack')).rejects.toThrow(BosError);
  });

  it('rejects absolute paths', async () => {
    await expect(resolveProfileDir('/etc/passwd')).rejects.toThrow(BosError);
    await expect(resolveProfileDir('C:\\Windows')).rejects.toThrow(BosError);
  });
});