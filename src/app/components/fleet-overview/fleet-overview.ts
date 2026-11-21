import { Component, computed, inject } from '@angular/core';
import { DemoState } from '../../demo-state';
import type { DemoDevice, UpsSnapshot } from '../../demo-data';

interface FleetRow {
  device: DemoDevice;
  snapshot: UpsSnapshot;
}

@Component({
  selector: 'app-fleet-overview',
  styleUrl: './fleet-overview.css',
  templateUrl: './fleet-overview.html',
})
export class FleetOverview {
  readonly state = inject(DemoState);
  readonly rows = computed(() =>
    this.state
      .devices()
      .map((device): FleetRow => ({ device, snapshot: this.state.snapshotFor(device.id) })),
  );
  readonly hostCount = computed(
    () =>
      new Set(
        this.state
          .devices()
          .map((device) => device.hostId)
          .filter(Boolean),
      ).size,
  );

  selectDevice(deviceId: string): void {
    this.state.selectDevice(deviceId);
  }

  loadLabel(snapshot: UpsSnapshot): string {
    if (snapshot.loadPercent !== null) {
      return `${new Intl.NumberFormat(undefined, { maximumFractionDigits: 1 }).format(snapshot.loadPercent)}%`;
    }
    if (snapshot.realPower !== null) {
      const value = new Intl.NumberFormat(undefined, { maximumFractionDigits: 0 }).format(
        snapshot.realPower,
      );
      return `${snapshot.powerEstimated ? '~' : ''}${value} W`;
    }
    return 'Unavailable';
  }
}
