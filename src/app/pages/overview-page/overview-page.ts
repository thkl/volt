import { Component, computed, inject } from '@angular/core';
import { RouterLink } from '@angular/router';
import { HistoryChart } from '../../components/history-chart/history-chart';
import { PowerFlow } from '../../components/power-flow/power-flow';
import { DemoState } from '../../demo-state';
import { EnergyImpactPanel } from '../../components/energy-impact-panel/energy-impact-panel';
import { FleetOverview } from '../../components/fleet-overview/fleet-overview';

@Component({
  imports: [EnergyImpactPanel, FleetOverview, HistoryChart, PowerFlow, RouterLink],
  selector: 'app-overview-page',
  styleUrl: './overview-page.css',
  templateUrl: './overview-page.html',
})
export class OverviewPage {
  readonly state = inject(DemoState);
  readonly snapshot = this.state.snapshot;
  readonly metrics = computed(() => {
    const sample = this.snapshot();
    return [
      {
        label: 'Input',
        value: metric(sample.inputVoltage),
        unit: sample.inputVoltage === null ? '' : 'V',
        icon: 'plug',
      },
      {
        label: 'Output',
        value: metric(sample.outputVoltage),
        unit: sample.outputVoltage === null ? '' : 'V',
        icon: 'outlet',
      },
      {
        label: 'Load',
        value: sample.realPower !== null ? String(sample.realPower) : metric(sample.loadPercent),
        unit: sample.realPower !== null ? 'W' : sample.loadPercent === null ? '' : '%',
        icon: 'load',
      },
      {
        label: 'Frequency',
        value: metric(sample.outputFrequency),
        unit: sample.outputFrequency === null ? '' : 'Hz',
        icon: 'wave',
      },
    ];
  });
  readonly rawVariables = computed(() => Object.entries(this.snapshot().rawVariables));

  readonly runtimeText = computed(() => formatRuntime(this.snapshot().runtimeSeconds));
  readonly batteryText = computed(() => {
    const charge = this.snapshot().batteryCharge;
    return charge === null ? '—' : `${charge}%`;
  });
  readonly batteryFill = computed(() => this.snapshot().batteryCharge ?? 0);
  readonly batteryNote = computed(() => {
    const sample = this.snapshot();
    if (sample.batteryCharge === null) return 'Battery charge was not reported by this device.';
    if (sample.lowBattery) return 'Reported charge is below the low battery threshold.';
    if (sample.flow === 'battery') return 'Power is being supplied from the battery.';
    return sample.charging
      ? 'Battery is charging from utility power.'
      : 'Battery charge reported by the UPS.';
  });
}

function metric(value: number | null): string {
  return value === null ? 'Unavailable' : String(value);
}

function formatRuntime(seconds: number | null): string {
  if (seconds === null) return 'Unavailable';
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  if (hours === 0) return `${minutes} min`;
  return minutes === 0 ? `${hours} hr` : `${hours} hr ${minutes} min`;
}
