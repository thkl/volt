import { Component, computed, effect, inject, input, signal } from '@angular/core';
import { ChartRange, DemoScenario, UpsSnapshot } from '../../demo-data';
import { BackendHistory, BackendHistoryPoint, LiveUpdates } from '../../live-updates';

@Component({
  imports: [],
  selector: 'app-history-chart',
  styleUrl: './history-chart.css',
  templateUrl: './history-chart.html',
})
export class HistoryChart {
  readonly snapshot = input.required<UpsSnapshot>();
  readonly scenario = input.required<DemoScenario>();
  readonly expanded = input(false);
  readonly liveMode = input(false);
  readonly deviceId = input('');
  readonly range = signal<ChartRange>('24h');
  readonly showPrimary = signal(true);
  readonly showVoltage = signal(true);
  private readonly pointer = signal<{ x: number; y: number } | null>(null);
  readonly ranges: ChartRange[] = ['1h', '24h', '7d', '30d'];
  private readonly liveUpdates = inject(LiveUpdates);
  private readonly liveHistory = signal<BackendHistory | null>(null);
  private historyRequest = 0;

  constructor() {
    effect(() => {
      const liveMode = this.liveMode();
      const deviceId = this.deviceId();
      const range = this.range();
      const request = ++this.historyRequest;
      if (!liveMode || !deviceId) {
        this.liveHistory.set(null);
        return;
      }
      void this.liveUpdates.getHistory(deviceId, range).then((history) => {
        if (request === this.historyRequest) this.liveHistory.set(history);
      });
    });
  }

  readonly chart = computed(() => {
    const sample = this.snapshot();
    const scenario = this.scenario();
    const history = this.liveHistory();
    const liveMode = this.liveMode();
    const livePowerPoints = validHistoryPoints(history?.series.realPower ?? []);
    const primaryIsPower = liveMode ? livePowerPoints.length > 0 : sample.realPower !== null;
    const primaryPoints: BackendHistoryPoint[] = liveMode
      ? primaryIsPower
        ? livePowerPoints
        : validHistoryPoints(history?.series.loadPercent ?? [])
      : [];
    const primaryValues = liveMode
      ? primaryPoints.map((point) => point.value)
      : (() => {
          const basePrimary = primaryIsPower ? powerValues : loadValues;
          const currentPrimary = primaryIsPower ? sample.realPower : sample.loadPercent;
          const alignedPrimary = alignLatest(basePrimary, currentPrimary);
          return scenario === 'stale' ? withTrailingGap(alignedPrimary) : alignedPrimary;
        })();
    const timeDomain = historyTimeDomain(history, this.range());
    const primaryXPositions = liveMode ? timePositions(primaryPoints, timeDomain) : undefined;
    const voltagePoints = liveMode ? validHistoryPoints(history?.series.inputVoltage ?? []) : [];
    const voltageValues = liveMode
      ? voltagePoints.map((point) => point.value)
      : sample.inputVoltage === null
        ? []
        : scenario === 'stale'
          ? withTrailingGap(alignLatest(voltageValuesBase, sample.inputVoltage))
          : alignLatest(voltageValuesBase, sample.inputVoltage);
    const voltageXPositions = liveMode ? timePositions(voltagePoints, timeDomain) : undefined;
    const maximum = primaryIsPower ? 400 : 40;
    const minimum = 0;
    const voltageAvailable = voltageValues.length > 0;

    return {
      primaryLabel: primaryIsPower ? 'Power draw' : 'Load',
      primaryUnit: primaryIsPower ? 'W' : '%',
      primaryDescription: primaryIsPower ? 'Power draw in watts' : 'UPS load as a percentage',
      primaryMaximum: maximum,
      primaryLine: linePath(primaryValues, minimum, maximum, primaryXPositions),
      primaryArea: areaPath(primaryValues, minimum, maximum, primaryXPositions),
      voltageLine: voltageAvailable ? linePath(voltageValues, 225, 235, voltageXPositions) : '',
      leftTicks: primaryTicks(primaryIsPower),
      xTicks: liveMode ? timeTicksForDomain(timeDomain) : timeTicks(this.range()),
      voltageAvailable,
      voltageSummary: voltageAvailable
        ? 'Input voltage'
        : 'Input voltage unavailable for this state',
      summary: chartSummary(primaryValues, primaryIsPower ? 'W' : '%'),
      hover: {
        domain: timeDomain,
        primary: liveMode ? timedValues(primaryPoints) : valuesAsTimedValues(primaryValues, timeDomain),
        voltage: liveMode ? timedValues(voltagePoints) : valuesAsTimedValues(voltageValues, timeDomain),
        bucketMs: history?.bucketMs ?? RANGE_DURATION_MS[this.range()] / Math.max(primaryValues.length - 1, 1),
      },
      ariaLabel: `${primaryIsPower ? 'Power draw' : 'Load'} history${voltageAvailable ? ' and input voltage' : ''} for ${rangeLabel(this.range())}`,
    };
  });

  readonly hoverInfo = computed(() => {
    const pointer = this.pointer();
    if (!pointer) return null;
    const chart = this.chart();
    const domain = chart.hover.domain;
    const time = domain.start + ((pointer.x - 68) / 864) * (domain.end - domain.start);
    const primaryValue = valueAtTime(chart.hover.primary, time, chart.hover.bucketMs);
    const voltageValue = valueAtTime(chart.hover.voltage, time, chart.hover.bucketMs);
    if (primaryValue === null && voltageValue === null) return null;
    const xPercent = (pointer.x / 1000) * 100;
    const yPercent = (pointer.y / 242) * 100;
    const timeLabel = new Intl.DateTimeFormat(undefined, {
      dateStyle: 'medium',
      timeStyle: 'medium',
    }).format(new Date(time));
    const valueFormatter = new Intl.NumberFormat(undefined, { maximumFractionDigits: 1 });
    return {
      x: pointer.x,
      leftPercent: xPercent,
      topPercent: yPercent,
      placeLeft: pointer.x > 760,
      placeBelow: pointer.y < 80,
      time: timeLabel,
      primaryLabel: chart.primaryLabel,
      primaryUnit: chart.primaryUnit,
      primaryValue: primaryValue === null ? '—' : valueFormatter.format(primaryValue),
      voltageValue: voltageValue === null ? '—' : valueFormatter.format(voltageValue),
      primaryY:
        primaryValue === null ? null : valuePosition(primaryValue, 0, chart.primaryMaximum),
      voltageY: voltageValue === null ? null : valuePosition(voltageValue, 225, 235),
    };
  });

  moveTooltip(event: PointerEvent): void {
    const svg = event.currentTarget as SVGSVGElement;
    const bounds = svg.getBoundingClientRect();
    if (bounds.width === 0 || bounds.height === 0) return;
    const x = ((event.clientX - bounds.left) / bounds.width) * 1000;
    const y = ((event.clientY - bounds.top) / bounds.height) * 242;
    if (x < 68 || x > 932 || y < 24 || y > 190) {
      this.pointer.set(null);
      return;
    }
    this.pointer.set({ x, y });
  }

  clearTooltip(): void {
    this.pointer.set(null);
  }

  selectRange(range: ChartRange): void {
    this.clearTooltip();
    this.range.set(range);
  }

  togglePrimary(): void {
    this.showPrimary.update((value) => !value);
  }

  toggleVoltage(): void {
    this.showVoltage.update((value) => !value);
  }
}

interface Tick {
  x: number;
  y: number;
  label: string;
}

interface TimeDomain {
  start: number;
  end: number;
}

const RANGE_DURATION_MS: Record<ChartRange, number> = {
  '1h': 60 * 60_000,
  '24h': 24 * 60 * 60_000,
  '7d': 7 * 24 * 60 * 60_000,
  '30d': 30 * 24 * 60 * 60_000,
};

const powerValues = [
  154, 148, 140, 136, 144, 151, 155, 145, 139, 147, 158, 167, 158, 149, 153, 162, 171, 163, 152,
  148, 159, 174, 180, 169,
];

const loadValues = [
  22, 21, 20, 19, 21, 23, 24, 22, 20, 21, 24, 27, 25, 23, 24, 25, 27, 26, 23, 22, 24, 28, 29, 26,
];

const voltageValuesBase = [
  230.2, 229.9, 230.1, 230.4, 230.0, 229.8, 230.2, 230.5, 230.1, 230.3, 229.9, 230.0, 230.6, 230.2,
  229.8, 230.1, 230.4, 230.0, 229.7, 230.2, 230.5, 230.1, 230.3, 230.4,
];

function validHistoryPoints(points: BackendHistoryPoint[]): BackendHistoryPoint[] {
  return points.filter(
    (point) => Number.isFinite(Date.parse(point.observedAt)) && Number.isFinite(point.value),
  );
}

function historyTimeDomain(history: BackendHistory | null, range: ChartRange): TimeDomain {
  const timestamps = Object.values(history?.series ?? {})
    .flatMap((points) => points ?? [])
    .map((point) => Date.parse(point.observedAt))
    .filter(Number.isFinite);

  if (timestamps.length > 0) {
    const start = Math.min(...timestamps);
    const end = Math.max(...timestamps);
    if (start < end) return { start, end };
    const padding = Math.max(history?.bucketMs ?? 30_000, 30_000) / 2;
    return { start: start - padding, end: end + padding };
  }

  const fallbackEnd = history ? Date.parse(history.to) : Number.NaN;
  const end = Number.isFinite(fallbackEnd) ? fallbackEnd : Date.now();
  const fallbackStart = history ? Date.parse(history.from) : Number.NaN;
  const start = Number.isFinite(fallbackStart) ? fallbackStart : end - RANGE_DURATION_MS[range];
  return start < end ? { start, end } : { start: end - RANGE_DURATION_MS[range], end };
}

function timePositions(points: BackendHistoryPoint[], domain: TimeDomain): number[] {
  const plotLeft = 68;
  const plotWidth = 864;
  const duration = Math.max(domain.end - domain.start, 1);
  return points.map((point) => {
    const progress = (Date.parse(point.observedAt) - domain.start) / duration;
    return Math.round(plotLeft + Math.min(1, Math.max(0, progress)) * plotWidth);
  });
}

function timeTicksForDomain(domain: TimeDomain): Tick[] {
  const duration = Math.max(domain.end - domain.start, 1);
  const count = Math.min(7, Math.max(2, Math.ceil(duration / 60_000) + 1));
  const options: Intl.DateTimeFormatOptions =
    duration <= 60 * 60_000
      ? { hour: '2-digit', minute: '2-digit', second: '2-digit' }
      : duration < 24 * 60 * 60_000
        ? { hour: '2-digit', minute: '2-digit' }
        : duration <= 6 * 24 * 60 * 60_000
          ? { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }
          : { month: 'short', day: 'numeric' };
  const formatter = new Intl.DateTimeFormat(undefined, options);
  return Array.from({ length: count }, (_, index) => {
    const progress = index / (count - 1);
    const time = domain.start + progress * duration;
    return {
      x: Math.round(68 + progress * 864),
      y: 218,
      label: formatter.format(new Date(time)),
    };
  });
}

function withTrailingGap(values: number[]): Array<number | null> {
  return [...values.slice(0, -5), null, null, null, null, null];
}

function alignLatest(values: number[], latest: number | null): number[] {
  if (latest === null) return values;
  const offset = latest - values[values.length - 1];
  return values.map((value) => Math.round((value + offset) * 10) / 10);
}

function linePath(
  values: Array<number | null>,
  min: number,
  max: number,
  xPositions?: number[],
): string {
  return valueSegments(values)
    .map((segment) =>
      segment
        .map((value, index) => {
          const point = pointAt(value, segment.start + index, values.length, min, max, xPositions);
          return `${index === 0 ? 'M' : 'L'} ${point.x} ${point.y}`;
        })
        .join(' '),
    )
    .join(' ');
}

function areaPath(
  values: Array<number | null>,
  min: number,
  max: number,
  xPositions?: number[],
): string {
  return valueSegments(values)
    .filter((segment) => segment.length > 1)
    .map((segment) => {
      const points = segment.map((value, index) =>
        pointAt(value, segment.start + index, values.length, min, max, xPositions),
      );
      const baseline = 190;
      const first = points[0];
      const last = points[points.length - 1];
      return `M ${first.x} ${baseline} L ${points.map((point) => `${point.x} ${point.y}`).join(' L ')} L ${last.x} ${baseline} Z`;
    })
    .join(' ');
}

function valueSegments(values: Array<number | null>): Array<Array<number> & { start: number }> {
  const segments: Array<Array<number> & { start: number }> = [];
  let current: (Array<number> & { start: number }) | null = null;
  values.forEach((value, index) => {
    if (value === null) {
      current = null;
      return;
    }
    if (!current) {
      current = Object.assign([] as number[], { start: index });
      segments.push(current);
    }
    current.push(value);
  });
  return segments;
}

function pointAt(
  value: number,
  index: number,
  count: number,
  min: number,
  max: number,
  xPositions?: number[],
): { x: number; y: number } {
  const plotLeft = 68;
  const plotWidth = 864;
  const plotTop = 24;
  const plotHeight = 166;
  const fallbackX = plotLeft + (count <= 1 ? 0.5 : index / (count - 1)) * plotWidth;
  return {
    x: xPositions?.[index] ?? Math.round(fallbackX),
    y: Math.round(plotTop + ((max - value) / (max - min)) * plotHeight),
  };
}

function primaryTicks(isPower: boolean): Tick[] {
  const labels = isPower
    ? ['400 W', '300 W', '200 W', '100 W', '0 W']
    : ['40%', '30%', '20%', '10%', '0%'];
  return labels.map((label, index) => ({ x: 58, y: 26 + index * 41, label }));
}

function timeTicks(range: ChartRange): Tick[] {
  const labels: Record<ChartRange, string[]> = {
    '1h': ['−60m', '−50m', '−40m', '−30m', '−20m', '−10m', 'now'],
    '24h': ['00:00', '04:00', '08:00', '12:00', '16:00', '20:00', '24:00'],
    '7d': ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'],
    '30d': ['1', '6', '12', '18', '24', '30'],
  };
  const values = labels[range];
  const spacing = 864 / (values.length - 1);
  return values.map((label, index) => ({ x: 68 + index * spacing, y: 218, label }));
}

function chartSummary(values: Array<number | null>, unit: string): string {
  const present = values.filter((value): value is number => value !== null);
  if (present.length === 0) return 'No historical samples are available.';
  const latest = present[present.length - 1];
  const min = Math.min(...present);
  const max = Math.max(...present);
  return `Latest ${latest}${unit} · range ${min}–${max}${unit}. Missing samples remain visible as gaps.`;
}

function rangeLabel(range: ChartRange): string {
  return {
    '1h': 'the last hour',
    '24h': 'the last 24 hours',
    '7d': 'the last 7 days',
    '30d': 'the last 30 days',
  }[range];
}
