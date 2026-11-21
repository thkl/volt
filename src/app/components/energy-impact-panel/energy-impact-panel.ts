import { Component, OnDestroy, OnInit, computed, effect, inject, signal } from '@angular/core';
import { DemoState } from '../../demo-state';
import { LiveUpdates } from '../../live-updates';
import type { EnergyImpact, EnergyPeriodImpact } from '../../live-updates';

@Component({
  selector: 'app-energy-impact-panel',
  styleUrl: './energy-impact-panel.css',
  templateUrl: './energy-impact-panel.html',
})
export class EnergyImpactPanel implements OnInit, OnDestroy {
  readonly state = inject(DemoState);
  private readonly liveUpdates = inject(LiveUpdates);
  readonly energyImpact = signal<EnergyImpact | null>(null);
  readonly energyLoading = signal(false);
  readonly energyError = signal('');
  readonly energyPeriods = computed(() => {
    const impact = this.energyImpact();
    if (!impact) return [];
    return [
      { id: 'hour', label: 'Last hour', data: impact.periods.lastHour },
      { id: 'day', label: 'Last 24 hours', data: impact.periods.last24Hours },
      { id: 'month', label: 'Last 30 days', data: impact.periods.last30Days },
    ];
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
  private refreshTimer: number | undefined;
  private energyRequestId = 0;
  private readonly energySelectionEffect = effect(() => {
    const mode = this.state.backendMode();
    const deviceId = this.state.selectedDeviceId();
    this.liveUpdates.energyImpactRevision();
    if (mode === 'nut' || mode === 'multi' || mode === 'demo') {
      void this.refreshEnergyImpact(deviceId);
    } else {
      this.energyRequestId += 1;
      this.energyImpact.set(null);
      this.energyLoading.set(false);
    }
  });

  ngOnInit(): void {
    this.refreshTimer = window.setInterval(() => {
      const mode = this.state.backendMode();
      if (mode === 'nut' || mode === 'multi' || mode === 'demo') {
        void this.refreshEnergyImpact(this.state.selectedDeviceId());
      }
    }, 60_000);
  }

  ngOnDestroy(): void {
    if (this.refreshTimer !== undefined) window.clearInterval(this.refreshTimer);
    this.energyRequestId += 1;
  }

  async refreshEnergyImpact(deviceId = this.state.selectedDeviceId()): Promise<void> {
    const mode = this.state.backendMode();
    if (mode !== 'nut' && mode !== 'multi' && mode !== 'demo') {
      this.energyImpact.set(null);
      this.energyLoading.set(false);
      return;
    }
    const requestId = ++this.energyRequestId;
    this.energyLoading.set(true);
    this.energyError.set('');
    if (this.energyImpact()?.deviceId !== deviceId) this.energyImpact.set(null);
    try {
      const impact = await this.liveUpdates.getEnergyImpact(deviceId);
      if (requestId === this.energyRequestId) this.energyImpact.set(impact);
    } catch (error) {
      if (requestId === this.energyRequestId) {
        this.energyError.set(
          error instanceof Error ? error.message : 'Energy impact could not be loaded',
        );
      }
    } finally {
      if (requestId === this.energyRequestId) this.energyLoading.set(false);
    }
  }

  moneyLabel(value: number | null, currency: string): string {
    if (value === null) return '—';
    return new Intl.NumberFormat(undefined, {
      style: 'currency',
      currency,
      minimumFractionDigits: 2,
      maximumFractionDigits: 4,
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
