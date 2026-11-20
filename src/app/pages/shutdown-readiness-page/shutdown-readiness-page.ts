import { Component, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import type { DemoDevice } from '../../demo-data';
import { DemoState, SourceDiagnostic } from '../../demo-state';
import { LiveUpdates } from '../../live-updates';
import type { ShutdownCoordination, ShutdownReadinessPlan } from '../../shutdown-readiness-models';

interface ShutdownPlanDraft {
  systemsText: string;
  coordination: ShutdownCoordination;
}

interface ReadinessCheck {
  label: string;
  detail: string;
  complete: boolean;
  operatorConfirmed?: boolean;
}

@Component({
  imports: [FormsModule],
  selector: 'app-shutdown-readiness-page',
  styleUrl: './shutdown-readiness-page.css',
  templateUrl: './shutdown-readiness-page.html',
})
export class ShutdownReadinessPage {
  readonly state = inject(DemoState);
  private readonly liveUpdates = inject(LiveUpdates);
  readonly plans = signal<Record<string, ShutdownReadinessPlan>>({});
  readonly drafts = signal<Record<string, ShutdownPlanDraft>>({});
  readonly loading = signal(true);
  readonly savingDeviceId = signal<string | null>(null);
  readonly error = signal('');
  readonly notice = signal('');

  constructor() {
    void this.loadPlans();
  }

  planFor(deviceId: string): ShutdownReadinessPlan {
    return (
      this.plans()[deviceId] ?? {
        deviceId,
        dependentSystems: [],
        coordination: 'unverified',
        updatedAt: null,
      }
    );
  }

  draftFor(deviceId: string): ShutdownPlanDraft {
    return this.drafts()[deviceId] ?? { systemsText: '', coordination: 'unverified' };
  }

  updateSystems(deviceId: string, value: string): void {
    this.drafts.update((current) => ({
      ...current,
      [deviceId]: { ...this.draftFor(deviceId), systemsText: value },
    }));
  }

  updateCoordination(deviceId: string, value: string): void {
    if (value !== 'unverified' && value !== 'verified' && value !== 'not_configured') return;
    this.drafts.update((current) => ({
      ...current,
      [deviceId]: { ...this.draftFor(deviceId), coordination: value },
    }));
  }

  sourceFor(device: DemoDevice): SourceDiagnostic | undefined {
    const hostId = device.hostId;
    return hostId
      ? this.state.sourceHealth().find((source) => source.hostId === hostId)
      : undefined;
  }

  checksFor(device: DemoDevice): ReadinessCheck[] {
    const snapshot = this.state.snapshotFor(device.id);
    const source = this.sourceFor(device);
    const plan = this.planFor(device.id);
    return [
      {
        label: 'Collector reachable',
        detail: source?.connected
          ? `Last poll · ${this.pollLabel(source.lastPollAt)}`
          : 'Volt has no live connection to this source',
        complete: source?.connected ?? false,
      },
      {
        label: 'UPS status available',
        detail: snapshot.rawVariables['ups.status']
          ? `Reported status · ${snapshot.rawVariables['ups.status']}`
          : 'The UPS has not reported ups.status',
        complete: Boolean(snapshot.rawVariables['ups.status']) && snapshot.flow !== 'stale',
      },
      {
        label: 'Runtime available',
        detail:
          snapshot.runtimeSeconds === null
            ? 'Runtime is not reported by this UPS'
            : `${Math.round(snapshot.runtimeSeconds / 60)} minutes reported`,
        complete: snapshot.runtimeSeconds !== null,
      },
      {
        label: 'Dependent systems listed',
        detail:
          plan.dependentSystems.length > 0
            ? `${plan.dependentSystems.length} system${plan.dependentSystems.length === 1 ? '' : 's'} recorded`
            : 'Add the equipment that relies on this UPS',
        complete: plan.dependentSystems.length > 0,
        operatorConfirmed: true,
      },
      {
        label: 'Shutdown coordination checked',
        detail:
          plan.coordination === 'verified'
            ? 'Marked verified by an operator'
            : plan.coordination === 'not_configured'
              ? 'Marked as not configured'
              : 'Configuration has not been reviewed',
        complete: plan.coordination === 'verified',
        operatorConfirmed: true,
      },
    ];
  }

  readinessLabel(device: DemoDevice): string {
    if (this.state.isDemo() || this.sourceFor(device)?.sourceType === 'demo') return 'Demo data';
    const checks = this.checksFor(device);
    if (!checks[0]?.complete || !checks[1]?.complete) return 'Telemetry unavailable';
    if (checks.every((check) => check.complete)) return 'Operator confirmed';
    return 'Needs review';
  }

  readinessTone(device: DemoDevice): 'good' | 'warning' | 'muted' {
    const label = this.readinessLabel(device);
    if (label === 'Operator confirmed') return 'good';
    return label === 'Needs review' ? 'warning' : 'muted';
  }

  runtimeLabel(deviceId: string): string {
    const runtimeSeconds = this.state.snapshotFor(deviceId).runtimeSeconds;
    return runtimeSeconds === null ? 'Not reported' : `${Math.round(runtimeSeconds / 60)} min`;
  }

  pollLabel(value: string | null): string {
    if (!value) return 'not available';
    const timestamp = Date.parse(value);
    if (!Number.isFinite(timestamp)) return 'time unavailable';
    return new Date(timestamp).toLocaleString([], {
      dateStyle: 'medium',
      hour: '2-digit',
      minute: '2-digit',
    });
  }

  async save(deviceId: string): Promise<void> {
    const draft = this.draftFor(deviceId);
    const dependentSystems = draft.systemsText
      .split('\n')
      .map((name) => name.trim())
      .filter(Boolean);
    this.savingDeviceId.set(deviceId);
    this.error.set('');
    this.notice.set('');
    try {
      const plan = await this.liveUpdates.saveShutdownReadinessPlan(deviceId, {
        dependentSystems,
        coordination: draft.coordination,
      });
      this.plans.update((current) => ({ ...current, [deviceId]: plan }));
      this.drafts.update((current) => ({
        ...current,
        [deviceId]: {
          systemsText: plan.dependentSystems.join('\n'),
          coordination: plan.coordination,
        },
      }));
      this.notice.set(
        `Shutdown checklist saved for ${this.state.devices().find((item) => item.id === deviceId)?.name ?? 'UPS'}.`,
      );
    } catch (error) {
      this.error.set(
        error instanceof Error ? error.message : 'Shutdown readiness could not be saved',
      );
    } finally {
      this.savingDeviceId.set(null);
    }
  }

  private async loadPlans(): Promise<void> {
    this.loading.set(true);
    this.error.set('');
    try {
      const plans = await this.liveUpdates.getShutdownReadinessPlans();
      this.plans.set(Object.fromEntries(plans.map((plan) => [plan.deviceId, plan])));
      this.drafts.set(
        Object.fromEntries(
          plans.map((plan) => [
            plan.deviceId,
            {
              systemsText: plan.dependentSystems.join('\n'),
              coordination: plan.coordination,
            },
          ]),
        ),
      );
    } catch (error) {
      this.error.set(
        error instanceof Error ? error.message : 'Shutdown readiness could not be loaded',
      );
    } finally {
      this.loading.set(false);
    }
  }
}
