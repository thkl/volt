import { Component, computed, input } from '@angular/core';
import { UpsSnapshot } from '../../demo-data';

@Component({
  imports: [],
  selector: 'app-power-flow',
  styleUrl: './power-flow.css',
  templateUrl: './power-flow.html',
})
export class PowerFlow {
  readonly snapshot = input.required<UpsSnapshot>();

  readonly gridActive = computed(() => this.snapshot().flow === 'online');
  readonly loadActive = computed(
    () => this.snapshot().flow === 'online' || this.snapshot().flow === 'battery',
  );
  readonly stateLabel = computed(() => {
    const sample = this.snapshot();
    if (sample.flow === 'stale') return 'Last reading · ' + sample.observedAt;
    if (sample.flow === 'unknown') return 'Power source unknown · ' + sample.status;
    if (sample.lowBattery) return 'On battery · low battery reported';
    if (sample.flow === 'battery') return 'Running on battery';
    return sample.charging ? 'Utility power · battery charging' : 'Running on utility power';
  });
  readonly gridValue = computed(() => formatMetric(this.snapshot().inputVoltage, ' V'));
  readonly upsValue = computed(() => formatMetric(this.snapshot().batteryCharge, '%'));
  readonly upsScreenValue = computed(() => {
    const charge = this.snapshot().batteryCharge;
    return charge === null ? '—' : `${charge}%`;
  });
  readonly loadValue = computed(() => {
    const sample = this.snapshot();
    if (sample.realPower !== null) return `${sample.realPower} W`;
    if (sample.loadPercent !== null) return `${sample.loadPercent}% load`;
    return 'Unavailable';
  });
}

function formatMetric(value: number | null, unit: string): string {
  return value === null ? 'Unavailable' : `${value}${unit}`;
}
