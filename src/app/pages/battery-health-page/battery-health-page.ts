import { Component, computed, inject } from '@angular/core';
import { DemoState } from '../../demo-state';

type ReportTone = 'good' | 'warning' | 'critical' | 'neutral';

interface HealthDetail {
  label: string;
  value: string;
  source: string;
}

@Component({
  imports: [],
  selector: 'app-battery-health-page',
  styleUrl: './battery-health-page.css',
  templateUrl: './battery-health-page.html',
})
export class BatteryHealthPage {
  readonly state = inject(DemoState);
  readonly snapshot = this.state.snapshot;

  readonly batteryStatus = computed(() => variable(this.snapshot().rawVariables, 'battery.status'));
  readonly badPacks = computed(() =>
    numberVariable(this.snapshot().rawVariables, 'battery.packs.bad'),
  );
  readonly statusText = computed(() => {
    const badPacks = this.badPacks();
    if (badPacks !== null && badPacks > 0) {
      return `${badPacks} battery pack${badPacks === 1 ? '' : 's'} reported bad`;
    }
    return this.batteryStatus() ?? 'No UPS battery status reported';
  });
  readonly statusTone = computed<ReportTone>(() => {
    if ((this.badPacks() ?? 0) > 0) return 'critical';
    return reportTone(this.batteryStatus());
  });

  readonly selfTestResult = computed(() =>
    variable(this.snapshot().rawVariables, 'ups.test.result'),
  );
  readonly selfTestDate = computed(() => variable(this.snapshot().rawVariables, 'ups.test.date'));
  readonly selfTestTone = computed(() => reportTone(this.selfTestResult()));

  readonly batteryAge = computed(() => {
    const installedDate = variable(this.snapshot().rawVariables, 'battery.date');
    return installedDate ? describeAge(installedDate) : null;
  });
  readonly maintenanceDate = computed(() => {
    const date = variable(this.snapshot().rawVariables, 'battery.date.maintenance');
    return date ? describeMaintenance(date) : null;
  });
  readonly healthDataAvailable = computed(() => {
    const variables = this.snapshot().rawVariables;
    return [
      'battery.status',
      'battery.date',
      'battery.date.maintenance',
      'battery.packs.bad',
      'ups.test.result',
    ].some((key) => variable(variables, key) !== null);
  });

  readonly details = computed<HealthDetail[]>(() => {
    const snapshot = this.snapshot();
    const variables = snapshot.rawVariables;
    const batteryPacks = numberVariable(variables, 'battery.packs');
    const badPacks = numberVariable(variables, 'battery.packs.bad');
    const measuredCapacity = numberVariable(variables, 'battery.capacity');
    const nominalCapacity = numberVariable(variables, 'battery.capacity.nominal');

    return [
      {
        label: 'Battery chemistry',
        value: variable(variables, 'battery.type') ?? 'Not reported',
        source: 'battery.type',
      },
      {
        label: 'Battery packs',
        value: describePacks(batteryPacks, badPacks),
        source: 'battery.packs · battery.packs.bad',
      },
      {
        label: 'Reported capacity',
        value: describeCapacity(measuredCapacity, nominalCapacity),
        source: 'battery.capacity · battery.capacity.nominal',
      },
      {
        label: 'Battery voltage',
        value: snapshot.batteryVoltage === null ? 'Not reported' : `${snapshot.batteryVoltage} V`,
        source: 'battery.voltage',
      },
    ];
  });
}

function variable(variables: Record<string, string>, key: string): string | null {
  const value = variables[key]?.trim();
  return value || null;
}

function numberVariable(variables: Record<string, string>, key: string): number | null {
  const value = variable(variables, key);
  if (value === null || !/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function describePacks(total: number | null, bad: number | null): string {
  if (total === null && bad === null) return 'Not reported';
  if (total === null) return `${bad} bad`;
  return bad === null ? `${total} total` : `${total} total · ${bad} bad`;
}

function describeCapacity(measured: number | null, nominal: number | null): string {
  if (measured === null && nominal === null) return 'Not reported';
  if (measured === null) return `${nominal} Ah nominal`;
  if (nominal === null) return `${measured} Ah reported`;
  return `${measured} / ${nominal} Ah`;
}

function reportTone(value: string | null): ReportTone {
  if (!value) return 'neutral';
  const normalized = value.toLowerCase();
  if (
    /\b(no|not|without)\s+(?:bad|fail(?:ed|ure)?|error|replace|critical|warn(?:ing)?)\b/.test(
      normalized,
    )
  ) {
    return 'neutral';
  }
  if (/\b(bad|fail(?:ed|ure)?|error|replace|critical)\b/.test(normalized)) return 'critical';
  if (/\b(warn(?:ing)?|weak|low|aging)\b/.test(normalized)) return 'warning';
  if (/\b(pass(?:ed)?|good|healthy|normal|ok)\b/.test(normalized)) return 'good';
  return 'neutral';
}

function describeAge(value: string): { value: string; source: string } {
  const date = parseNutDate(value);
  if (!date) return { value, source: 'Battery installation or replacement date' };
  const now = new Date();
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  if (date.getTime() > today) {
    return { value, source: 'Reported installation date is in the future' };
  }
  let months = (now.getUTCFullYear() - date.getUTCFullYear()) * 12;
  months += now.getUTCMonth() - date.getUTCMonth();
  if (now.getUTCDate() < date.getUTCDate()) months -= 1;
  if (months < 0) return { value, source: 'Less than one month ago' };
  const years = Math.floor(months / 12);
  const remainingMonths = months % 12;
  const age = [
    years ? `${years} year${years === 1 ? '' : 's'}` : '',
    remainingMonths ? `${remainingMonths} month${remainingMonths === 1 ? '' : 's'}` : '',
  ]
    .filter(Boolean)
    .join(' ');
  return {
    value: age || 'Less than one month',
    source: `Installed or replaced ${formatDate(date)} · ${value}`,
  };
}

function describeMaintenance(value: string): { value: string; source: string; tone: ReportTone } {
  const date = parseNutDate(value);
  if (!date) return { value, source: 'Maintenance date reported by UPS', tone: 'neutral' };

  const now = new Date();
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const dueAt = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
  const days = Math.ceil((dueAt - today) / 86_400_000);
  if (days < 0) {
    return {
      value: `Overdue by ${Math.abs(days)} day${Math.abs(days) === 1 ? '' : 's'}`,
      source: `Maintenance date · ${formatDate(date)} · ${value}`,
      tone: 'warning',
    };
  }
  if (days === 0) {
    return {
      value: 'Due today',
      source: `Maintenance date · ${formatDate(date)} · ${value}`,
      tone: 'warning',
    };
  }
  return {
    value: days <= 30 ? `Due in ${days} day${days === 1 ? '' : 's'}` : formatDate(date),
    source: `Maintenance date · ${value}`,
    tone: days <= 30 ? 'warning' : 'neutral',
  };
}

function parseNutDate(value: string): Date | null {
  let year: number;
  let month: number;
  let day: number;
  let match = /^(\d{4})[-/](\d{1,2})[-/](\d{1,2})$/.exec(value);
  if (match) {
    year = Number(match[1]);
    month = Number(match[2]);
    day = Number(match[3]);
  } else if ((match = /^(\d{1,2})\/(\d{1,2})\/(\d{2}|\d{4})$/.exec(value))) {
    month = Number(match[1]);
    day = Number(match[2]);
    year = Number(match[3]);
    if (year < 100) year += year < 50 ? 2000 : 1900;
  } else if ((match = /^(\d{1,2})\.(\d{1,2})\.(\d{4})$/.exec(value))) {
    day = Number(match[1]);
    month = Number(match[2]);
    year = Number(match[3]);
  } else {
    return null;
  }

  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day
    ? date
    : null;
}

function formatDate(date: Date): string {
  return new Intl.DateTimeFormat(undefined, {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    timeZone: 'UTC',
  }).format(date);
}
