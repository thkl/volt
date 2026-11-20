import { describe, expect, it } from 'vitest';
import { decryptCredentials, encryptCredentials } from './credentials.js';

describe('host credential encryption', () => {
  const key = '0123456789abcdef'.repeat(4);

  it('encrypts credentials and decrypts them with the configured key', () => {
    const credentials = { username: 'reader', password: 'correct horse battery staple' };
    const encrypted = encryptCredentials(credentials, key);

    expect(encrypted).not.toContain(credentials.username);
    expect(encrypted).not.toContain(credentials.password);
    expect(decryptCredentials(encrypted, key)).toEqual(credentials);
  });

  it('rejects a wrong key and tampered ciphertext', () => {
    const encrypted = encryptCredentials({ username: 'reader', password: 'secret' }, key);
    const changed = JSON.parse(encrypted) as { data: string };
    changed.data = `${changed.data.slice(0, -4)}AAAA`;

    expect(() => decryptCredentials(encrypted, 'f'.repeat(64))).toThrow(
      'Could not decrypt host credentials',
    );
    expect(() => decryptCredentials(JSON.stringify(changed), key)).toThrow(
      'Could not decrypt host credentials',
    );
  });
});
