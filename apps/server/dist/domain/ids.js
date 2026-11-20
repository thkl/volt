import { createHash } from 'node:crypto';
export function stableDeviceId(sourceId, upsName) {
    return createHash('sha256').update(`${sourceId}/${upsName}`).digest('hex').slice(0, 24);
}
