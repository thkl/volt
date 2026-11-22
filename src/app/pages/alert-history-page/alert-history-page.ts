import {
  Component,
  OnDestroy,
  OnInit,
  computed,
  effect,
  inject,
  signal,
  untracked,
} from '@angular/core';
import { DemoState } from '../../demo-state';
import { AlertHistoryEntry, LiveUpdates } from '../../live-updates';

type HistoryFilter = 'all' | 'failures' | 'suppressed';

@Component({
  imports: [],
  selector: 'app-alert-history-page',
  styleUrl: './alert-history-page.css',
  templateUrl: './alert-history-page.html',
})
export class AlertHistoryPage implements OnInit, OnDestroy {
  readonly state = inject(DemoState);
  private readonly liveUpdates = inject(LiveUpdates);
  readonly entries = signal<AlertHistoryEntry[]>([]);
  readonly filter = signal<HistoryFilter>('all');
  readonly loading = signal(false);
  readonly loadError = signal('');
  readonly refreshedAt = signal<string | null>(null);
  readonly visibleEntries = computed(() => {
    const filter = this.filter();
    return this.entries().filter((entry) => {
      if (filter === 'failures') {
        return entry.status === 'failed' || entry.status === 'partially-failed';
      }
      if (filter === 'suppressed') return entry.status === 'suppressed';
      return true;
    });
  });
  private refreshTimer: number | undefined;
  private requestId = 0;

  constructor() {
    effect(() => {
      const connected = this.state.apiConnected();
      untracked(() => {
        if (connected) {
          void this.refresh();
        } else {
          this.entries.set([]);
          this.loadError.set('Reconnect to Volt to view persisted alert history.');
        }
      });
    });
  }

  ngOnInit(): void {
    this.refreshTimer = window.setInterval(() => void this.refresh(), 30_000);
  }

  ngOnDestroy(): void {
    if (this.refreshTimer !== undefined) window.clearInterval(this.refreshTimer);
    this.requestId += 1;
  }

  async refresh(): Promise<void> {
    if (!this.state.apiConnected() || this.loading()) return;
    const request = ++this.requestId;
    this.loading.set(true);
    this.loadError.set('');
    try {
      const entries = await this.liveUpdates.getAlertHistory();
      if (request !== this.requestId) return;
      this.entries.set(entries);
      this.refreshedAt.set(new Date().toISOString());
    } catch (error) {
      if (request === this.requestId) {
        this.loadError.set(
          error instanceof Error ? error.message : 'Alert history could not be loaded.',
        );
      }
    } finally {
      if (request === this.requestId) this.loading.set(false);
    }
  }

  selectFilter(event: Event): void {
    this.filter.set((event.target as HTMLSelectElement).value as HistoryFilter);
  }

  statusLabel(status: AlertHistoryEntry['status']): string {
    switch (status) {
      case 'delivered':
        return 'Delivered';
      case 'partially-failed':
        return 'Partially failed';
      case 'failed':
        return 'Failed';
      case 'suppressed':
        return 'Suppressed';
      case 'no-channel':
        return 'No channel';
    }
  }

  channelLabel(channel: 'pushover' | 'email'): string {
    return channel === 'pushover' ? 'Pushover' : 'Email';
  }

  formatTime(value: string): string {
    const timestamp = Date.parse(value);
    return Number.isFinite(timestamp)
      ? new Date(timestamp).toLocaleString([], { dateStyle: 'medium', timeStyle: 'medium' })
      : value;
  }

  refreshedLabel(): string {
    const value = this.refreshedAt();
    if (!value) return '';
    const timestamp = Date.parse(value);
    return Number.isFinite(timestamp)
      ? `Updated ${new Date(timestamp).toLocaleTimeString([], { timeStyle: 'short' })}`
      : '';
  }
}
