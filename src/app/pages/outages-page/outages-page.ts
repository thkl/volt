import { Component, DestroyRef, computed, effect, inject, signal } from '@angular/core';
import { DemoState } from '../../demo-state';
import { LiveUpdates } from '../../live-updates';
import {
  OUTAGE_RANGES,
  type OutageEpisode,
  type OutageRange,
  type OutageSummary,
} from '../../outage-models';

const RANGE_LABELS: Record<OutageRange, string> = {
  '24h': '24 hours',
  '7d': '7 days',
  '30d': '30 days',
  '90d': '90 days',
};

@Component({
  imports: [],
  selector: 'app-outages-page',
  styleUrl: './outages-page.css',
  templateUrl: './outages-page.html',
})
export class OutagesPage {
  readonly state = inject(DemoState);
  private readonly liveUpdates = inject(LiveUpdates);
  readonly ranges = OUTAGE_RANGES;
  readonly selectedRange = signal<OutageRange>('30d');
  readonly report = signal<OutageSummary | null>(null);
  readonly loading = signal(false);
  readonly loadError = signal<string | null>(null);
  readonly nowMs = signal(Date.now());
  readonly rangeLabel = computed(() => RANGE_LABELS[this.selectedRange()]);
  readonly confirmedBatteryDurationMs = computed(() => {
    const summary = this.report();
    if (!summary) return 0;

    const rangeStartMs = Date.parse(summary.from);
    const reportedAtMs = Date.parse(summary.to);
    const currentTimeMs = Math.max(this.nowMs(), reportedAtMs);
    const elapsedSinceReport = summary.outages.reduce((total, episode) => {
      if (episode.status !== 'ongoing' || episode.uncertainty !== null || !episode.startedAt) {
        return total;
      }
      const periodStartMs = Math.max(Date.parse(episode.startedAt), rangeStartMs);
      const durationAtReport = Math.max(0, reportedAtMs - periodStartMs);
      const durationNow = Math.max(0, currentTimeMs - periodStartMs);
      return total + Math.max(0, durationNow - durationAtReport);
    }, 0);

    return summary.confirmedDurationMs + elapsedSinceReport;
  });
  readonly currentOutage = computed(
    () => this.report()?.outages.find((outage) => outage.status === 'ongoing') ?? null,
  );

  constructor() {
    const destroyRef = inject(DestroyRef);
    const timer = window.setInterval(() => this.nowMs.set(Date.now()), 30_000);
    destroyRef.onDestroy(() => window.clearInterval(timer));

    let requestId = 0;
    effect(() => {
      const deviceId = this.state.selectedDeviceId();
      const mode = this.state.backendMode();
      const apiConnected = this.state.apiConnected();
      const scenario = this.state.scenario();
      const range = this.selectedRange();
      this.liveUpdates.outageRevision();
      const request = ++requestId;

      if (mode === 'none') {
        this.report.set(null);
        this.loadError.set(null);
        this.loading.set(false);
      } else if (mode === null || (mode === 'demo' && !apiConnected)) {
        this.report.set(createDemoSummary(deviceId, scenario, range));
        this.loadError.set(null);
        this.loading.set(false);
      } else if (!apiConnected) {
        this.report.set(null);
        this.loadError.set('Reconnect to Volt to load outage history.');
        this.loading.set(false);
      } else {
        this.report.set(null);
        this.loadError.set(null);
        this.loading.set(true);
        void this.liveUpdates.getOutageSummary(deviceId, range).then((report) => {
          if (request !== requestId) return;
          this.report.set(report);
          this.loading.set(false);
          this.loadError.set(report ? null : 'Outage history could not be loaded.');
        });
      }
    });
  }

  selectRange(value: OutageRange): void {
    this.selectedRange.set(value);
  }

  formatDuration(durationMs: number | null): string {
    if (durationMs === null) return 'Duration unavailable';
    const totalMinutes = Math.floor(durationMs / 60_000);
    if (totalMinutes === 0 && durationMs <= 0) return '0 min';
    if (totalMinutes < 1) return 'Under a minute';
    const days = Math.floor(totalMinutes / (24 * 60));
    const hours = Math.floor((totalMinutes % (24 * 60)) / 60);
    const minutes = totalMinutes % 60;
    if (days > 0) return `${days}d ${hours}h`;
    if (hours > 0) return `${hours}h ${minutes}m`;
    return `${minutes} min`;
  }

  episodeDuration(episode: OutageEpisode): string {
    if (episode.status === 'uncertain') return 'Duration uncertain';
    if (episode.status === 'ongoing' && episode.uncertainty) return 'Duration uncertain · ongoing';
    if (episode.status === 'ongoing' && episode.startedAt) {
      return `${this.formatDuration(Math.max(0, this.nowMs() - Date.parse(episode.startedAt)))} · ongoing`;
    }
    return this.formatDuration(episode.durationMs);
  }

  uncertaintyText(episode: OutageEpisode): string {
    switch (episode.uncertainty) {
      case 'connection-gap':
        return 'A connection gap makes the exact battery duration uncertain.';
      case 'missing-start':
        if (episode.status === 'ongoing') {
          return 'The UPS is on battery now, but its start time is outside the recorded data.';
        }
        return 'The utility return was observed, but the battery start time is missing.';
      case 'missing-return':
        if (episode.endedAt) {
          return 'The UPS is online again, but the exact utility restoration time is unknown.';
        }
        return 'A return to utility power was not confirmed after the last battery reading.';
      default:
        return '';
    }
  }

  formatTime(value: string | null): string {
    if (!value) return 'Time unavailable';
    const date = new Date(value);
    return Number.isNaN(date.valueOf())
      ? 'Time unavailable'
      : date.toLocaleString([], {
          day: 'numeric',
          month: 'short',
          year: 'numeric',
          hour: '2-digit',
          minute: '2-digit',
        });
  }
}

function createDemoSummary(
  deviceId: string,
  scenario: string,
  range: OutageRange,
  now = Date.now(),
): OutageSummary {
  const hour = 60 * 60_000;
  const day = 24 * hour;
  const duration = (minutes: number) => minutes * 60_000;
  const periods: OutageEpisode[] = [
    demoEpisode(1, now - 3 * hour, now - 3 * hour + duration(12)),
    demoEpisode(2, now - 2 * day - 5 * hour, now - 2 * day - 5 * hour + duration(7)),
    {
      id: -3,
      startedAt: new Date(now - 12 * day - 4 * hour).toISOString(),
      endedAt: new Date(now - 12 * day - 4 * hour + duration(26)).toISOString(),
      durationMs: duration(26),
      status: 'uncertain',
      uncertainty: 'connection-gap',
    },
    demoEpisode(4, now - 18 * day - 2 * hour, now - 18 * day - 2 * hour + duration(24)),
    demoEpisode(5, now - 55 * day - hour, now - 55 * day - hour + duration(9)),
  ];
  const activeMinutes = scenario === 'low-battery' ? 43 : scenario === 'on-battery' ? 17 : null;
  if (activeMinutes !== null) {
    periods.unshift({
      id: null,
      startedAt: new Date(now - duration(activeMinutes)).toISOString(),
      endedAt: null,
      durationMs: duration(activeMinutes),
      status: 'ongoing',
      uncertainty: null,
    });
  }

  const rangeMs: Record<OutageRange, number> = {
    '24h': day,
    '7d': 7 * day,
    '30d': 30 * day,
    '90d': 90 * day,
  };
  const fromMs = now - rangeMs[range];
  const outages = periods.filter((episode) => {
    const end = episode.endedAt ? Date.parse(episode.endedAt) : now;
    return end >= fromMs;
  });
  const confirmedDurations = outages.flatMap((episode) => {
    if (
      (episode.status !== 'completed' && episode.status !== 'ongoing') ||
      episode.uncertainty !== null ||
      !episode.startedAt
    ) {
      return [];
    }
    const startMs = Math.max(Date.parse(episode.startedAt), fromMs);
    const endMs = Math.min(episode.endedAt ? Date.parse(episode.endedAt) : now, now);
    return [Math.max(0, endMs - startMs)];
  });
  const completed = outages.filter((episode) => episode.status === 'completed');
  return {
    deviceId,
    range,
    from: new Date(fromMs).toISOString(),
    to: new Date(now).toISOString(),
    outageCount: outages.length,
    completedCount: completed.length,
    uncertainCount: outages.filter(
      (episode) => episode.status === 'uncertain' || episode.uncertainty !== null,
    ).length,
    confirmedDurationMs: confirmedDurations.reduce((total, value) => total + value, 0),
    longestConfirmedDurationMs: confirmedDurations.length ? Math.max(...confirmedDurations) : null,
    outages,
  };
}

function demoEpisode(id: number, startMs: number, endMs: number): OutageEpisode {
  return {
    id: -id,
    startedAt: new Date(startMs).toISOString(),
    endedAt: new Date(endMs).toISOString(),
    durationMs: endMs - startMs,
    status: 'completed',
    uncertainty: null,
  };
}
