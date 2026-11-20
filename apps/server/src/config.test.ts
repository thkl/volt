import { describe, expect, it } from 'vitest';
import { loadConfig } from './config.js';

describe('loadConfig', () => {
  it('defaults to local demo mode and bounds polling configuration', () => {
    const config = loadConfig({});
    expect(config.demoMode).toBe(true);
    expect(config.pollIntervalMs).toBe(5000);
    expect(config.nutHost).toBeNull();
  });

  it('allows live mode with no host configured yet', () => {
    expect(loadConfig({ DEMO_MODE: 'false' })).toMatchObject({ demoMode: false, nutHost: null });
  });

  it('rejects invalid numeric configuration', () => {
    expect(() => loadConfig({ POLL_INTERVAL_SECONDS: '0' })).toThrow('between 1 and 300');
  });

  it('allows NUT authentication with or without TLS', () => {
    const base = {
      DEMO_MODE: 'false',
      NUT_HOST: 'ups.example.test',
      NUT_USERNAME: 'volt-reader',
      NUT_PASSWORD: 'secret',
    };
    expect(loadConfig(base)).toMatchObject({
      nutTls: false,
      nutUsername: 'volt-reader',
      nutPassword: 'secret',
    });
    expect(loadConfig({ ...base, NUT_TLS: 'true' })).toMatchObject({
      nutTls: true,
      nutUsername: 'volt-reader',
      nutPassword: 'secret',
    });
  });

  it('requires NUT username and password as a pair', () => {
    expect(() =>
      loadConfig({ DEMO_MODE: 'false', NUT_HOST: 'ups.example.test', NUT_USERNAME: 'reader' }),
    ).toThrow('must be configured together');
  });
});
