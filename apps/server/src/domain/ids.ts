import { createHash } from 'node:crypto';

export function stableDeviceId(sourceId: string, upsName: string): string {
  return createHash('sha256').update(`${sourceId}/${upsName}`).digest('hex').slice(0, 24);
}
