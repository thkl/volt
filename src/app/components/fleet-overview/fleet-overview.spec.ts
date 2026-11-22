import { TestBed } from '@angular/core/testing';
import { describe, expect, it } from 'vitest';
import { DemoState } from '../../demo-state';
import { FleetOverview } from './fleet-overview';

describe('FleetOverview', () => {
  it('shows one row per configured UPS and selects the requested device', () => {
    TestBed.configureTestingModule({ providers: [DemoState] });
    const state = TestBed.inject(DemoState);
    state.devices.update((devices) =>
      devices.map((device, index) => ({ ...device, hostId: index === 0 ? 'host-a' : 'host-b' })),
    );
    const fleet = TestBed.runInInjectionContext(() => new FleetOverview());
    const secondDevice = state.devices()[1];

    expect(fleet.rows()).toHaveLength(state.devices().length);
    expect(fleet.rows()[0]?.device.id).toBe(state.devices()[0]?.id);
    expect(fleet.hostCount()).toBe(2);
    if (!secondDevice) throw new Error('Expected a second demo device');

    fleet.selectDevice(secondDevice.id);

    expect(state.selectedDeviceId()).toBe(secondDevice.id);
  });

  it('prefers load percentage and marks estimated power in the load label', () => {
    TestBed.configureTestingModule({ providers: [DemoState] });
    const fleet = TestBed.runInInjectionContext(() => new FleetOverview());
    const base = TestBed.inject(DemoState).snapshot();

    expect(fleet.loadLabel({ ...base, loadPercent: 24.5, realPower: 180 })).toBe('24.5%');
    expect(
      fleet.loadLabel({ ...base, loadPercent: null, realPower: 180.4, powerEstimated: true }),
    ).toBe('~180 W');
    expect(fleet.loadLabel({ ...base, loadPercent: null, realPower: null })).toBe('Unavailable');
  });
});
