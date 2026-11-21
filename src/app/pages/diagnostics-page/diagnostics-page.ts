import { Component, OnDestroy, OnInit, computed, inject, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { DemoState, SourceDiagnostic } from '../../demo-state';
import { LiveUpdates, VoltInternals } from '../../live-updates';

const DIAGNOSTIC_VARIABLES = [
  'ups.status',
  'battery.charge',
  'battery.runtime',
  'ups.load',
  'ups.realpower',
  'input.voltage',
  'output.voltage',
  'ups.alarm',
  'ups.test.result',
  'ups.delay.shutdown',
];

@Component({
  imports: [RouterLink],
  selector: 'app-diagnostics-page',
  styleUrl: './diagnostics-page.css',
  templateUrl: './diagnostics-page.html',
})
export class DiagnosticsPage implements OnInit, OnDestroy {
  readonly state = inject(DemoState);
  readonly liveUpdates = inject(LiveUpdates);
  readonly sources = computed(() => this.state.sourceHealth());
  readonly internals = signal<VoltInternals | null>(null);
  readonly internalsLoading = signal(true);
  readonly internalsError = signal(false);
  private refreshTimer: number | undefined;
  private refreshInFlight = false;

  ngOnInit(): void {
    void this.refreshInternals();
    this.refreshTimer = window.setInterval(() => void this.refreshInternals(), 30_000);
  }

  ngOnDestroy(): void {
    if (this.refreshTimer !== undefined) window.clearInterval(this.refreshTimer);
  }

  devicesForSource(hostId: string) {
    return this.state.devices().filter((device) => device.hostId === hostId);
  }

  endpoint(source: SourceDiagnostic): string {
    if (!source.host)
      return source.sourceType === 'demo' ? 'Built-in simulator' : 'Address unavailable';
    return `${source.host}:${source.port ?? 3493}`;
  }

  connectionLabel(source: SourceDiagnostic): string {
    if (!source.connected) return 'Disconnected';
    return source.status === 'degraded' ? 'Connected · degraded' : 'Connected';
  }

  phaseLabel(value: string | null): string {
    return value ? value.replaceAll('-', ' ') : 'Starting';
  }

  pollLabel(value: string | null): string {
    if (!value) return 'No successful poll yet';
    const timestamp = Date.parse(value);
    if (!Number.isFinite(timestamp)) return 'Time unavailable';
    return new Date(timestamp).toLocaleString([], {
      dateStyle: 'medium',
      timeStyle: 'medium',
    });
  }

  variables(deviceId: string): string[] {
    const reported = this.state.snapshotFor(deviceId).rawVariables;
    return DIAGNOSTIC_VARIABLES.filter((key) => Object.hasOwn(reported, key));
  }

  runtimeLabel(seconds: number | null): string {
    return seconds === null ? 'Not reported' : `${Math.round(seconds / 60)} min`;
  }

  missingVariables(deviceId: string): string[] {
    const reported = this.state.snapshotFor(deviceId).rawVariables;
    return DIAGNOSTIC_VARIABLES.filter((key) => !Object.hasOwn(reported, key));
  }

  uptimeLabel(milliseconds: number): string {
    const totalMinutes = Math.floor(milliseconds / 60_000);
    if (totalMinutes < 1) return 'Under a minute';
    const days = Math.floor(totalMinutes / 1440);
    const hours = Math.floor((totalMinutes % 1440) / 60);
    const minutes = totalMinutes % 60;
    return [
      days > 0 ? `${days}d` : null,
      hours > 0 ? `${hours}h` : null,
      minutes > 0 ? `${minutes}m` : null,
    ]
      .filter((part): part is string => part !== null)
      .join(' ');
  }

  bytesLabel(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`;
    const units = ['KiB', 'MiB', 'GiB', 'TiB'];
    let value = bytes;
    let unit = -1;
    do {
      value /= 1024;
      unit += 1;
    } while (value >= 1024 && unit < units.length - 1);
    return `${value.toFixed(1)} ${units[unit]}`;
  }

  refreshedLabel(value: string): string {
    const timestamp = Date.parse(value);
    return Number.isFinite(timestamp)
      ? `Updated ${new Date(timestamp).toLocaleTimeString([], { timeStyle: 'short' })}`
      : 'Update time unavailable';
  }

  private async refreshInternals(): Promise<void> {
    if (this.refreshInFlight) return;
    this.refreshInFlight = true;
    const result = await this.liveUpdates.getVoltInternals();
    if (result) {
      this.internals.set(result);
      this.internalsError.set(false);
    } else {
      this.internalsError.set(true);
    }
    this.internalsLoading.set(false);
    this.refreshInFlight = false;
  }
}
