import { Component, computed, inject } from '@angular/core';
import { RouterLink } from '@angular/router';
import { DemoState, SourceDiagnostic } from '../../demo-state';

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
export class DiagnosticsPage {
  readonly state = inject(DemoState);
  readonly sources = computed(() => this.state.sourceHealth());

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
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
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
}
