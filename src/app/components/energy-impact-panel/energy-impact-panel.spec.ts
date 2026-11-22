import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import type { ComponentFixture } from '@angular/core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DemoState } from '../../demo-state';
import { LiveUpdates } from '../../live-updates';
import type { EnergyImpact } from '../../live-updates';
import { EnergyImpactPanel } from './energy-impact-panel';

class LiveUpdatesStub {
  readonly energyImpactRevision = signal(0);
  readonly energyImpactUpdates = signal<Record<string, EnergyImpact>>({});
  readonly energyImpactErrors = signal<Record<string, string>>({});
  readonly subscribeEnergyImpact = vi.fn();
  readonly refreshEnergyImpact = vi.fn();

  energyImpactFor(deviceId: string): EnergyImpact | null {
    return this.energyImpactUpdates()[deviceId] ?? null;
  }

  energyImpactErrorFor(deviceId: string): string {
    return this.energyImpactErrors()[deviceId] ?? '';
  }
}

describe('EnergyImpactPanel', () => {
  let state: DemoState;
  let liveUpdates: LiveUpdatesStub;
  let fixture: ComponentFixture<EnergyImpactPanel>;

  beforeEach(async () => {
    state = new DemoState();
    state.backendMode.set('nut');
    liveUpdates = new LiveUpdatesStub();

    await TestBed.configureTestingModule({
      imports: [EnergyImpactPanel],
      providers: [
        { provide: DemoState, useValue: state },
        { provide: LiveUpdates, useValue: liveUpdates },
      ],
    }).compileComponents();

    fixture = TestBed.createComponent(EnergyImpactPanel);
    fixture.detectChanges();
    await fixture.whenStable();
  });

  it('does not resubscribe when a pushed impact updates the panel', async () => {
    const deviceId = state.selectedDeviceId();
    expect(liveUpdates.subscribeEnergyImpact).toHaveBeenCalledTimes(1);

    liveUpdates.energyImpactUpdates.set({ [deviceId]: createImpact(deviceId) });
    fixture.detectChanges();
    await fixture.whenStable();

    expect(fixture.componentInstance.energyImpact()?.deviceId).toBe(deviceId);
    expect(liveUpdates.subscribeEnergyImpact).toHaveBeenCalledTimes(1);
  });

  it('refreshes the active subscription when energy settings change', async () => {
    liveUpdates.energyImpactRevision.update((revision) => revision + 1);
    fixture.detectChanges();
    await fixture.whenStable();

    expect(liveUpdates.refreshEnergyImpact).toHaveBeenCalledTimes(1);
    expect(liveUpdates.subscribeEnergyImpact).toHaveBeenCalledTimes(1);
  });
});

function createImpact(deviceId: string): EnergyImpact {
  const period = {
    energyKwh: 0.1,
    estimatedEnergyKwh: 0.1,
    cost: 0.03,
    co2Kg: 0,
    coveragePercent: 100,
  };
  return {
    deviceId,
    timeZone: 'UTC',
    currency: 'EUR',
    pricePerKwh: 0.3,
    carbonIntensityGramsPerKwh: 0,
    maxGapSeconds: 60,
    periods: { lastHour: period, last24Hours: period, last30Days: period },
    dayparts: [],
    dailyTrend: [],
  };
}
