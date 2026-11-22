import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AlertService } from './alert-service.js';
import type { HostManager } from '../collector/host-manager.js';
import type { UpsSnapshot } from '../domain/models.js';
import type { Store } from '../storage/store.js';

describe('AlertService', () => {
  let service: AlertService;
  let collector: EventEmitter & { sourceHealthById: () => { sourceType: string } };
  let recordAlertHistory: ReturnType<typeof vi.fn>;

  afterEach(() => {
    service?.close();
    vi.restoreAllMocks();
  });

  it('records enabled events when there is no configured delivery channel', async () => {
    ({ service, collector, recordAlertHistory } = createService([]));
    collector.emit(
      'snapshot',
      snapshot('ups-live', 'fresh'),
      [{ type: 'on-battery', detail: 'Utility power failed' }],
      'host-live',
    );
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(recordAlertHistory).toHaveBeenCalledWith(
      expect.objectContaining({
        deviceId: 'ups-live',
        eventType: 'on-battery',
        title: 'UPS switched to battery power',
        status: 'no-channel',
        channels: [],
      }),
    );
  });

  it('suppresses the initial connection-restored notification for existing devices', () => {
    ({ service, collector, recordAlertHistory } = createService([{ id: 'ups-existing' }]));
    collector.emit(
      'snapshot',
      snapshot('ups-existing', 'fresh'),
      [{ type: 'connection-restored', detail: 'NUT host connected' }],
      'host-live',
    );

    expect(recordAlertHistory).toHaveBeenCalledWith(
      expect.objectContaining({
        deviceId: 'ups-existing',
        eventType: 'connection-restored',
        status: 'suppressed',
        detail: 'Startup recovery notifications are suppressed.',
      }),
    );
  });

  it('ignores demo snapshots so demo events do not enter alert history', async () => {
    ({ service, collector, recordAlertHistory } = createService([]));
    collector.sourceHealthById = () => ({ sourceType: 'demo' });
    collector.emit(
      'snapshot',
      snapshot('demo-ups', 'fresh'),
      [{ type: 'on-battery', detail: 'Demo transition' }],
      'demo-host',
    );
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(recordAlertHistory).not.toHaveBeenCalled();
  });
});

function createService(devices: Array<{ id: string }>) {
  const recordAlertHistory = vi.fn();
  const store = {
    getAppSetting: () => null,
    listDevices: () => devices,
    recordAlertHistory,
    listAlertHistory: () => [],
    setAppSetting: vi.fn(),
  } as unknown as Store;
  const collector = Object.assign(new EventEmitter(), {
    sourceHealthById: () => ({ sourceType: 'nut' }),
  });
  const service = new AlertService(store, 'a'.repeat(64), collector as unknown as HostManager);
  return { service, collector, recordAlertHistory };
}

function snapshot(deviceId: string, freshness: 'fresh' | 'stale'): UpsSnapshot {
  return {
    deviceId,
    deviceName: deviceId,
    freshness,
    runtimeSeconds: null,
  } as UpsSnapshot;
}
