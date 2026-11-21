import { Component, OnDestroy, OnInit, computed, effect, inject, signal } from '@angular/core';
import { DemoState } from '../../demo-state';
import type { DemoDevice, UpsSnapshot } from '../../demo-data';
import { LiveUpdates } from '../../live-updates';
import type { EnergyImpact } from '../../live-updates';

type StatusTone = 'good' | 'warning' | 'critical' | 'muted';

interface FleetRow {
  device: DemoDevice;
  snapshot: UpsSnapshot;
  energy: EnergyImpact | null;
  stateLabel: string;
  stateTone: StatusTone;
}

@Component({
  selector: 'app-fleet-overview',
  styleUrl: './fleet-overview.css',
  templateUrl: './fleet-overview.html',
})
export class FleetOverview implements OnInit, OnDestroy {
  readonly state = inject(DemoState);
  private readonly liveUpdates = inject(LiveUpdates);
  readonly energyByDevice = signal<Record<string, EnergyImpact>>({});
  readonly energyLoading = signal(false);
  readonly energyErrors = signal<Record<string, boolean>>({});
  readonly rows = computed(() => {
    const energyByDevice = this.energyByDevice();
    return this.state.devices().map((device): FleetRow => {
      const snapshot = this.state.snapshotFor(device.id);
      const state = stateFor(snapshot);
      return {
        device,
        snapshot,
        energy: energyByDevice[device.id] ?? null,
        stateLabel: state.label,
        stateTone: state.tone,
      };
    });
  });
  readonly hostCount = computed(
    () =>
      new Set(
        this.state
          .devices()
          .map((device) => device.hostId)
          .filter(Boolean),
      ).size,
  );
  private refreshTimer: number | undefined;
  private requestId = 0;
  private readonly refreshEffect = effect(() => {
    const mode = this.state.backendMode();
    const deviceIds = this.state.devices().map((device) => device.id);
    this.liveUpdates.energyImpactRevision();
    if ((mode === 'nut' || mode === 'multi' || mode === 'demo') && deviceIds.length > 0) {
      void this.refreshEnergy(deviceIds);
    } else {
      this.requestId += 1;
      this.energyByDevice.set({});
      this.energyErrors.set({});
      this.energyLoading.set(false);
    }
  });

  ngOnInit(): void {
    this.refreshTimer = window.setInterval(() => {
      const mode = this.state.backendMode();
      if (mode === 'nut' || mode === 'multi' || mode === 'demo') {
        void this.refreshEnergy(this.state.devices().map((device) => device.id));
      }
    }, 60_000);
  }

  ngOnDestroy(): void {
    if (this.refreshTimer !== undefined) window.clearInterval(this.refreshTimer);
    this.requestId += 1;
  }

  selectDevice(deviceId: string): void {
    this.state.selectDevice(deviceId);
  }

  powerLabel(snapshot: UpsSnapshot): string {
    if (snapshot.realPower !== null) {
      const value = new Intl.NumberFormat(undefined, { maximumFractionDigits: 0 }).format(
        snapshot.realPower,
      );
      return `${snapshot.powerEstimated ? '~' : ''}${value} W`;
    }
    if (snapshot.loadPercent !== null) return `${snapshot.loadPercent}% load`;
    return 'Unavailable';
  }

  energyLabel(row: FleetRow): string {
    if (!row.energy) {
      if (this.state.backendMode() === null) return 'Unavailable';
      if (this.energyErrors()[row.device.id]) return 'Unavailable';
      return this.energyLoading() ? 'Loading…' : 'Unavailable';
    }
    const energy = row.energy.periods.last24Hours.energyKwh;
    return energy === null ? 'No readings' : `${energy.toFixed(3)} kWh`;
  }

  costLabel(row: FleetRow): string {
    const energy = row.energy;
    if (!energy) {
      if (this.state.backendMode() === null) return 'No stored history';
      return this.energyErrors()[row.device.id] ? 'Unavailable' : 'Loading…';
    }
    if (energy.pricePerKwh === null) return 'Set in Settings';
    const cost = energy.periods.last24Hours.cost;
    if (cost === null) return 'Collecting data';
    return new Intl.NumberFormat(undefined, {
      style: 'currency',
      currency: energy.currency,
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    }).format(cost);
  }

  coverageLabel(row: FleetRow): string {
    const period = row.energy?.periods.last24Hours;
    if (!period) return '';
    const coverage = `${period.coveragePercent.toFixed(0)}% of last 24h covered`;
    if (period.estimatedEnergyKwh > 0) return `${coverage} · includes UPS-estimated power`;
    return coverage;
  }

  hasLowCoverage(row: FleetRow): boolean {
    const coverage = row.energy?.periods.last24Hours.coveragePercent;
    return coverage !== undefined && coverage < 80;
  }

  private async refreshEnergy(deviceIds: string[]): Promise<void> {
    const requestId = ++this.requestId;
    this.energyLoading.set(true);
    const results = await Promise.all(
      deviceIds.map(async (deviceId) => {
        try {
          return {
            deviceId,
            energy: await this.liveUpdates.getEnergyImpact(deviceId),
            error: false,
          };
        } catch {
          return { deviceId, energy: null, error: true };
        }
      }),
    );
    if (requestId !== this.requestId) return;

    const activeIds = new Set(this.state.devices().map((device) => device.id));
    this.energyByDevice.update((current) => {
      const next = Object.fromEntries(
        Object.entries(current).filter(([deviceId]) => activeIds.has(deviceId)),
      );
      for (const result of results) {
        if (result.energy) next[result.deviceId] = result.energy;
      }
      return next;
    });
    this.energyErrors.set(
      Object.fromEntries(
        results.filter((result) => result.error).map((result) => [result.deviceId, true]),
      ),
    );
    this.energyLoading.set(false);
  }
}

function stateFor(snapshot: UpsSnapshot): { label: string; tone: StatusTone } {
  if (snapshot.flow === 'stale') return { label: 'Data stale', tone: 'muted' };
  if (snapshot.flow === 'unknown') return { label: 'Unknown', tone: 'muted' };
  if (snapshot.lowBattery) return { label: 'Low battery', tone: 'critical' };
  if (snapshot.flow === 'battery') return { label: 'On battery', tone: 'warning' };
  if (snapshot.charging) return { label: 'Charging', tone: 'good' };
  return { label: 'Online', tone: 'good' };
}
