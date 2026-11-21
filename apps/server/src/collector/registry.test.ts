import { describe, expect, it } from 'vitest';
import { createDefaultCollectorRegistry, type CollectorContext } from './registry.js';

describe('collector registry', () => {
  const registry = createDefaultCollectorRegistry();

  it('marks implemented and planned source types in the catalog', () => {
    expect(registry.catalog()).toEqual(
      expect.arrayContaining([
        { type: 'mqtt', label: 'MQTT', implemented: false },
        { type: 'homeassistant', label: 'Home Assistant', implemented: true },
        { type: 'unifi-http', label: 'UniFi UPS HTTP API', implemented: false },
      ]),
    );
    expect(() => registry.create('mqtt', {} as CollectorContext)).toThrow(
      'registered for future use but not implemented',
    );
  });
});
