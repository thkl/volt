import { Component, OnDestroy, computed, effect, inject, signal, untracked } from '@angular/core';
import { DemoState } from '../../demo-state';
import { LiveUpdates } from '../../live-updates';
import type { EnergyImpact, EnergyPeriodImpact } from '../../live-updates';

@Component({
  selector: 'app-energy-impact-panel',
  styleUrl: './energy-impact-panel.css',
  templateUrl: './energy-impact-panel.html',
})
export class EnergyImpactPanel implements OnDestroy {
  private readonly lowCoverageThresholdPercent = 80;
  readonly state = inject(DemoState);
  private readonly liveUpdates = inject(LiveUpdates);
  private lastEnergyImpactRevision = this.liveUpdates.energyImpactRevision();
  readonly energyImpact = signal<EnergyImpact | null>(null);
  readonly energyLoading = signal(false);
  readonly energyError = signal('');
  readonly energyPeriods = computed(() => {
    const impact = this.energyImpact();
    if (!impact) return [];
    return [
      {
        id: 'hour',
        label: 'Last hour',
        projectionLabel: null,
        data: impact.periods.lastHour,
      },
      {
        id: 'day',
        label: 'Last 24 hours',
        projectionLabel: 'Projected 24h cost',
        data: impact.periods.last24Hours,
      },
      {
        id: 'month',
        label: 'Last 30 days',
        projectionLabel: 'Projected 30d cost',
        data: impact.periods.last30Days,
      },
    ];
  });
  readonly daypartTotalEnergy = computed(() => {
    const impact = this.energyImpact();
    if (!impact || !impact.dayparts.some((part) => part.energyKwh !== null)) return null;
    return impact.dayparts.reduce((total, part) => total + (part.energyKwh ?? 0), 0);
  });
  readonly energyTrendMaximum = computed(() => {
    const impact = this.energyImpact();
    if (!impact) return 0;
    return Math.max(
      0,
      ...impact.dailyTrend.map((point) =>
        impact.pricePerKwh === null ? (point.energyKwh ?? 0) : (point.cost ?? 0),
      ),
    );
  });
  private readonly energySelectionEffect = effect(() => {
    const mode = this.state.backendMode();
    const deviceId = this.state.selectedDeviceId();
    if (mode === 'nut' || mode === 'homeassistant' || mode === 'multi' || mode === 'demo') {
      untracked(() => this.liveUpdates.subscribeEnergyImpact(deviceId));
      this.energyLoading.set(true);
      this.energyError.set('');
      if (untracked(() => this.energyImpact())?.deviceId !== deviceId) {
        this.energyImpact.set(null);
      }
    } else {
      untracked(() => this.liveUpdates.subscribeEnergyImpact(null));
      this.energyImpact.set(null);
      this.energyLoading.set(false);
    }
  });

  private readonly energySettingsEffect = effect(() => {
    const revision = this.liveUpdates.energyImpactRevision();
    if (revision === this.lastEnergyImpactRevision) return;
    this.lastEnergyImpactRevision = revision;
    untracked(() => this.liveUpdates.refreshEnergyImpact());
  });

  private readonly energyPushEffect = effect(() => {
    const deviceId = this.state.selectedDeviceId();
    const impact = this.liveUpdates.energyImpactFor(deviceId);
    if (impact) {
      this.energyImpact.set(impact);
      this.energyLoading.set(false);
      this.energyError.set('');
    }
    const error = this.liveUpdates.energyImpactErrorFor(deviceId);
    if (error) {
      this.energyError.set(error);
      this.energyLoading.set(false);
    }
  });

  ngOnDestroy(): void {
    this.liveUpdates.subscribeEnergyImpact(null);
  }

  moneyLabel(value: number | null, currency: string): string {
    if (value === null) return '—';
    return new Intl.NumberFormat(undefined, {
      style: 'currency',
      currency,
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    }).format(value);
  }

  energyLabel(value: number | null): string {
    return value === null ? 'No readings' : `${value.toFixed(3)} kWh`;
  }

  footprintLabel(value: number | null): string {
    if (value === null) return 'Not configured';
    if (value < 1) return `${Math.round(value * 1000)} g CO₂e`;
    return `${value.toFixed(3)} kg CO₂e`;
  }

  projectedCostLabel(period: EnergyPeriodImpact, currency: string): string {
    if (period.cost === null || period.coveragePercent <= 0) return 'Collecting data';
    const projectedCost = period.cost / (period.coveragePercent / 100);
    return this.moneyLabel(projectedCost, currency);
  }

  hasLowCoverage(period: EnergyPeriodImpact): boolean {
    return period.coveragePercent < this.lowCoverageThresholdPercent;
  }

  coverageWarning(period: EnergyPeriodImpact): string {
    if (period.coveragePercent <= 0) {
      return 'No usable readings for this period yet, so the total and projection are unavailable.';
    }
    return `Only ${period.coveragePercent.toFixed(1)}% of this period has usable readings. The measured total may be low; the projection extrapolates the observed average and may be inaccurate.`;
  }

  daypartChartBackground(): string {
    const impact = this.energyImpact();
    const colors = ['#4dbb78', '#79d98a', '#e3c35c', '#dd9460'];
    const energies = impact?.dayparts.map((part) => part.energyKwh ?? 0) ?? [];
    const total = energies.reduce((sum, energy) => sum + energy, 0);
    if (total <= 0) return 'conic-gradient(#30383c 0% 100%)';

    let cursor = 0;
    const stops = energies.map((energy, index) => {
      const start = cursor;
      cursor += (energy / total) * 100;
      return `${colors[index] ?? '#30383c'} ${start}% ${cursor}%`;
    });
    return `conic-gradient(${stops.join(', ')})`;
  }

  daypartChartLabel(): string {
    const impact = this.energyImpact();
    if (!impact) return 'Today energy by time of day';
    const summary = impact.dayparts
      .map((part) => `${part.label}: ${this.energyLabel(part.energyKwh)}`)
      .join(', ');
    return `Today energy by time of day. ${summary}`;
  }

  coverageLabel(period: EnergyPeriodImpact): string {
    return `Data coverage ${Math.round(period.coveragePercent)}%`;
  }

  trendBarHeight(point: EnergyImpact['dailyTrend'][number]): string {
    const impact = this.energyImpact();
    const value = impact?.pricePerKwh === null ? (point.energyKwh ?? 0) : (point.cost ?? 0);
    const maximum = this.energyTrendMaximum();
    return maximum > 0 ? `${Math.max(2, (value / maximum) * 100)}%` : '0%';
  }

  trendTooltip(point: EnergyImpact['dailyTrend'][number]): string {
    const impact = this.energyImpact();
    const cost = this.moneyLabel(point.cost, impact?.currency ?? 'EUR');
    const energy = this.energyLabel(point.energyKwh);
    return `${point.date} · ${energy} · ${cost} · ${this.footprintLabel(point.co2Kg)}`;
  }

  trendDateLabel(date: string): string {
    const timestamp = Date.parse(`${date}T12:00:00`);
    return Number.isFinite(timestamp)
      ? new Date(timestamp).toLocaleDateString([], { month: 'short', day: 'numeric' })
      : date;
  }
}
