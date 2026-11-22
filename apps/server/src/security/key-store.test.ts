import { mkdtempSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadOrCreateCredentialKey } from './key-store.js';

describe('loadOrCreateCredentialKey', () => {
  let directory: string | undefined;

  afterEach(() => {
    if (directory) rmSync(directory, { recursive: true, force: true });
    directory = undefined;
  });

  it('creates a private key file and reuses its key on the next start', () => {
    directory = mkdtempSync(join(tmpdir(), 'volt-credential-key-'));
    const databasePath = join(directory, 'data', 'volt.sqlite');

    const first = loadOrCreateCredentialKey(databasePath, null);
    const second = loadOrCreateCredentialKey(databasePath, null);

    expect(first).toMatch(/^[a-f0-9]{64}$/);
    expect(second).toBe(first);
    expect(statSync(join(directory, 'data', 'credentials.key')).mode & 0o077).toBe(0);
  });

  it('uses a configured key and rejects symlinked persisted keys', () => {
    directory = mkdtempSync(join(tmpdir(), 'volt-credential-key-'));
    expect(loadOrCreateCredentialKey(join(directory, 'volt.sqlite'), 'configured-key')).toBe(
      'configured-key',
    );

    const keyPath = join(directory, 'credentials.key');
    const target = join(directory, 'external-key');
    const databasePath = join(directory, 'volt.sqlite');
    writeFileSync(target, 'a'.repeat(64));
    symlinkSync(target, keyPath);

    expect(() => loadOrCreateCredentialKey(databasePath, null)).toThrow(
      'Credential key path must be a regular file',
    );
  });
});
