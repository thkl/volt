import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  readEnvironmentSecret,
  resolveEnvironmentSecret,
  resolveFileBackedSecrets,
} from './secret-env.js';

describe('file-backed environment secrets', () => {
  let directory: string | undefined;

  afterEach(() => {
    if (directory) rmSync(directory, { recursive: true, force: true });
    directory = undefined;
  });

  it('uses the direct environment value before the secret file', () => {
    directory = mkdtempSync(join(tmpdir(), 'volt-secret-env-'));
    const secretFile = join(directory, 'password');
    writeFileSync(secretFile, 'file-secret\n');

    expect(
      resolveEnvironmentSecret(
        { AUTH_PASSWORD: 'environment-secret', AUTH_PASSWORD_FILE: secretFile },
        'AUTH_PASSWORD',
      ),
    ).toEqual({ value: 'environment-secret', source: 'environment' });
  });

  it('reads secret files and removes only trailing line breaks', () => {
    directory = mkdtempSync(join(tmpdir(), 'volt-secret-env-'));
    const secretFile = join(directory, 'password');
    writeFileSync(secretFile, ' secret with spaces  \r\n');

    expect(readEnvironmentSecret({ AUTH_PASSWORD_FILE: secretFile }, 'AUTH_PASSWORD')).toBe(
      ' secret with spaces  ',
    );
  });

  it('resolves file-backed values into a clean environment', () => {
    directory = mkdtempSync(join(tmpdir(), 'volt-secret-env-'));
    const secretFile = join(directory, 'email');
    writeFileSync(secretFile, 'volt@example.test\n');

    expect(resolveFileBackedSecrets({ AUTH_EMAIL_FILE: secretFile })).toMatchObject({
      AUTH_EMAIL: 'volt@example.test',
    });
    expect(resolveFileBackedSecrets({ AUTH_EMAIL_FILE: secretFile })).not.toHaveProperty(
      'AUTH_EMAIL_FILE',
    );
  });
});
