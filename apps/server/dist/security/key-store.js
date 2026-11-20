import { randomBytes } from 'node:crypto';
import { chmodSync, closeSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, writeFileSync, } from 'node:fs';
import { dirname, resolve } from 'node:path';
export function loadOrCreateCredentialKey(databasePath, configuredKey) {
    if (configuredKey)
        return configuredKey;
    const directory = databasePath === ':memory:' ? resolve('.data') : dirname(databasePath);
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const keyPath = resolve(directory, 'credentials.key');
    const generatedKey = randomBytes(32).toString('hex');
    try {
        const descriptor = openSync(keyPath, 'wx', 0o600);
        try {
            writeFileSync(descriptor, generatedKey, 'utf8');
            fsyncSync(descriptor);
        }
        finally {
            closeSync(descriptor);
        }
        return generatedKey;
    }
    catch (error) {
        if (error.code !== 'EEXIST')
            throw error;
    }
    const metadata = lstatSync(keyPath);
    if (!metadata.isFile() || metadata.isSymbolicLink()) {
        throw new Error('Credential key path must be a regular file');
    }
    if ((metadata.mode & 0o077) !== 0)
        chmodSync(keyPath, 0o600);
    const key = readFileSync(keyPath, 'utf8').trim();
    if (!/^[A-Fa-f0-9]{64}$/.test(key)) {
        throw new Error('Stored credential key is invalid');
    }
    return key;
}
