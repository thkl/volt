import { Component, effect, inject, signal } from '@angular/core';
import { DemoState } from '../../demo-state';
import { IncidentEvent, LiveUpdates } from '../../live-updates';

const INCIDENT_PAGE_SIZE = 50;

@Component({
  imports: [],
  selector: 'app-events-page',
  styleUrl: './events-page.css',
  templateUrl: './events-page.html',
})
export class EventsPage {
  readonly state = inject(DemoState);
  private readonly liveUpdates = inject(LiveUpdates);
  readonly entries = signal<IncidentEvent[]>([]);
  readonly deviceFilter = signal('all');
  readonly nextCursor = signal<string | null>(null);
  readonly loading = signal(false);
  readonly loadingMore = signal(false);
  readonly loadError = signal('');
  readonly demoEntries = signal<IncidentEvent[]>([]);
  private requestId = 0;

  constructor() {
    effect(() => {
      const connected = this.state.apiConnected();
      const demo = this.state.isDemo();
      this.liveUpdates.eventRevision();

      if (connected) {
        void this.loadPage(true, false);
      } else if (demo) {
        this.requestId += 1;
        this.loading.set(false);
        this.loadingMore.set(false);
        this.loadError.set('');
        this.nextCursor.set(null);
        this.demoEntries.set(
          this.state.events().map((event, index) => ({
            id: event.id ?? -(index + 1),
            deviceId: event.deviceId ?? this.state.selectedDeviceId(),
            deviceName: event.device,
            occurredAt: event.time,
            type: event.type,
            detail: event.detail,
            tone: event.tone,
          })),
        );
      } else {
        this.requestId += 1;
        this.loading.set(false);
        this.loadingMore.set(false);
        this.entries.set([]);
        this.nextCursor.set(null);
        this.loadError.set('Reconnect to Volt to load incident history.');
      }
    });
  }

  readonly visibleEntries = () => (this.state.apiConnected() ? this.entries() : this.demoEntries());

  selectDevice(event: Event): void {
    this.deviceFilter.set((event.target as HTMLSelectElement).value);
    if (this.state.apiConnected()) void this.loadPage(true, true);
    else this.filterDemoEntries();
  }

  async refresh(): Promise<void> {
    if (this.state.apiConnected()) await this.loadPage(false, true);
  }

  async loadMore(): Promise<void> {
    const cursor = this.nextCursor();
    if (!cursor || this.loadingMore()) return;
    this.loadingMore.set(true);
    this.loadError.set('');
    const request = ++this.requestId;
    try {
      const page = await this.liveUpdates.getIncidentPage({
        cursor,
        limit: INCIDENT_PAGE_SIZE,
        ...(this.deviceFilter() !== 'all' ? { deviceId: this.deviceFilter() } : {}),
      });
      if (request !== this.requestId) return;
      const existingIds = new Set(this.entries().map((entry) => entry.id));
      this.entries.update((current) => [
        ...current,
        ...page.data.filter((entry) => !existingIds.has(entry.id)),
      ]);
      this.nextCursor.set(page.nextCursor);
    } catch (error) {
      if (request === this.requestId) {
        this.loadError.set(
          error instanceof Error ? error.message : 'Incident history could not be loaded.',
        );
      }
    } finally {
      if (request === this.requestId) this.loadingMore.set(false);
    }
  }

  formatTime(value: string): string {
    const timestamp = Date.parse(value);
    if (!Number.isFinite(timestamp)) return value;
    return new Date(timestamp).toLocaleString([], {
      dateStyle: 'medium',
      timeStyle: 'medium',
    });
  }

  displayType(value: string): string {
    return value
      .split('-')
      .map((part) => `${part.slice(0, 1).toUpperCase()}${part.slice(1)}`)
      .join(' ');
  }

  private async loadPage(reset: boolean, showLoading: boolean): Promise<void> {
    const request = ++this.requestId;
    const existing = reset ? [] : this.entries();
    if (reset) this.entries.set([]);
    if (showLoading || reset) this.loading.set(true);
    this.loadError.set('');
    try {
      const page = await this.liveUpdates.getIncidentPage({
        limit: INCIDENT_PAGE_SIZE,
        ...(this.deviceFilter() !== 'all' ? { deviceId: this.deviceFilter() } : {}),
      });
      if (request !== this.requestId) return;
      const refreshedIds = new Set(page.data.map((entry) => entry.id));
      this.entries.set([...page.data, ...existing.filter((entry) => !refreshedIds.has(entry.id))]);
      this.nextCursor.set(page.nextCursor);
    } catch (error) {
      if (request === this.requestId) {
        this.loadError.set(
          error instanceof Error ? error.message : 'Incident history could not be loaded.',
        );
      }
    } finally {
      if (request === this.requestId) {
        this.loading.set(false);
        this.loadingMore.set(false);
      }
    }
  }

  private filterDemoEntries(): void {
    const filter = this.deviceFilter();
    const entries = this.state.events().map((event, index) => ({
      id: event.id ?? -(index + 1),
      deviceId: event.deviceId ?? this.state.selectedDeviceId(),
      deviceName: event.device,
      occurredAt: event.time,
      type: event.type,
      detail: event.detail,
      tone: event.tone,
    }));
    this.demoEntries.set(
      filter === 'all' ? entries : entries.filter((entry) => entry.deviceId === filter),
    );
  }
}
