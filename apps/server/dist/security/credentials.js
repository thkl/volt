import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
export function encryptCredentials(credentials, key) {
    if (!isCredentialSet(credentials))
        throw new Error('At least one string credential is required');
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', decodeKey(key), iv);
    const data = Buffer.concat([cipher.update(JSON.stringify(credentials), 'utf8'), cipher.final()]);
    const envelope = {
        version: 1,
        algorithm: 'aes-256-gcm',
        iv: iv.toString('base64'),
        tag: cipher.getAuthTag().toString('base64'),
        data: data.toString('base64'),
    };
    return JSON.stringify(envelope);
}
export function decryptCredentials(value, key) {
    try {
        const envelope = JSON.parse(value);
        if (envelope.version !== 1 ||
            envelope.algorithm !== 'aes-256-gcm' ||
            !envelope.iv ||
            !envelope.tag ||
            !envelope.data) {
            throw new Error('Invalid credential envelope');
        }
        const decipher = createDecipheriv('aes-256-gcm', decodeKey(key), Buffer.from(envelope.iv, 'base64'));
        decipher.setAuthTag(Buffer.from(envelope.tag, 'base64'));
        const plaintext = Buffer.concat([
            decipher.update(Buffer.from(envelope.data, 'base64')),
            decipher.final(),
        ]).toString('utf8');
        const credentials = JSON.parse(plaintext);
        if (!isCredentialSet(credentials)) {
            throw new Error('Invalid credential payload');
        }
        return credentials;
    }
    catch {
        throw new Error('Could not decrypt host credentials; check CREDENTIALS_ENCRYPTION_KEY');
    }
}
function isCredentialSet(value) {
    if (typeof value !== 'object' || value === null || Array.isArray(value))
        return false;
    const entries = Object.entries(value);
    return (entries.length > 0 && entries.every(([key, item]) => key.length > 0 && typeof item === 'string'));
}
function decodeKey(key) {
    const decoded = /^[A-Fa-f0-9]{64}$/.test(key)
        ? Buffer.from(key, 'hex')
        : Buffer.from(key, 'base64');
    if (decoded.length !== 32)
        throw new Error('Credential encryption key must be 32 bytes');
    return decoded;
}
