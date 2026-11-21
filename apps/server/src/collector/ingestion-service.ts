import { EventEmitter } from 'node:events';
import type { Freshness, UpsSnapshot } from '../domain/models.js';
import { Store, type PowerEventInput } from '../storage/store.js';

export interface IngestionOptions {
  hostId: string;
  sampleIntervalMs: number;
}

export class IngestionService extends EventEmitter {
  private stopped = false;

  constructor(
    private readonly store: Store,
    private readonly options: IngestionOptions,
  ) {
    super();
  }

  stop(): void {
    this.stopped = true;
  }

  ingest(snapshot: UpsSnapshot, description = snapshot.deviceName): void {
    if (this.stopped) return;
    const previous = this.store.getDevice(snapshot.deviceId)?.snapshot ?? null;
    const events = previous ? detectTransitions(previous, snapshot, new Date().toISOString()) : [];
    const observedAtMs = Date.parse(snapshot.observedAt);
    const lastSampleAt = this.store.getLastSampleAt(snapshot.deviceId);
    const includeSample =
      lastSampleAt === null ||
      events.length > 0 ||
      (snapshot.freshness === 'fresh' &&
        observedAtMs - lastSampleAt >= this.options.sampleIntervalMs);

    this.store.writeObservation(snapshot, description, this.options.hostId, events, includeSample);
    this.emit('snapshot', snapshot, events);
  }

  markUnavailable(deviceId: string, detail: string, freshness: Freshness = 'stale'): void {
    if (this.stopped) return;
    const device = this.store.getDevice(deviceId);
    const previous = device?.snapshot;
    if (!device || !previous || previous.freshness !== 'fresh') return;

    const now = new Date().toISOString();
    const snapshot: UpsSnapshot = {
      ...previous,
      flow: 'stale',
      freshness,
    };
    const event = makeEvent(
      snapshot,
      now,
      'connection-lost',
      detail,
      'neutral',
      previous.freshness,
      freshness,
    );
    this.store.writeObservation(snapshot, device.description, this.options.hostId, [event], false);
    this.emit('snapshot', snapshot, [event]);
  }
}

function detectTransitions(
  previous: UpsSnapshot,
  current: UpsSnapshot,
  occurredAt: string,
): PowerEventInput[] {
  const events: PowerEventInput[] = [];
  if (previous.freshness === 'fresh' && current.freshness !== 'fresh') {
    events.push(
      makeEvent(
        current,
        occurredAt,
        'connection-lost',
        'No successful poll in three intervals',
        'neutral',
        previous.freshness,
        current.freshness,
      ),
    );
  }
  if (previous.freshness !== 'fresh' && current.freshness === 'fresh') {
    events.push(
      makeEvent(
        current,
        occurredAt,
        'connection-restored',
        'The UPS is reporting data again',
        'good',
        previous.freshness,
        current.freshness,
      ),
    );
  }

  if (previous.flow !== current.flow && current.flow === 'battery') {
    events.push(
      makeEvent(
        current,
        occurredAt,
        'on-battery',
        'The UPS reports battery power',
        'warning',
        previous.flow,
        current.flow,
      ),
    );
  } else if (previous.flow === 'battery' && current.flow === 'online') {
    events.push(
      makeEvent(
        current,
        occurredAt,
        'mains-restored',
        'Power returned to utility supply',
        'good',
        previous.flow,
        current.flow,
      ),
    );
  }

  if (!previous.lowBattery && current.lowBattery) {
    events.push(
      makeEvent(
        current,
        occurredAt,
        'low-battery',
        'The UPS reports the LB status flag',
        'critical',
        'normal',
        'low',
      ),
    );
  } else if (previous.lowBattery && !current.lowBattery) {
    events.push(
      makeEvent(
        current,
        occurredAt,
        'battery-normal',
        'The UPS cleared the LB status flag',
        'good',
        'low',
        'normal',
      ),
    );
  }

  if (previous.flow !== 'unknown' && current.flow === 'unknown' && current.freshness === 'fresh') {
    events.push(
      makeEvent(
        current,
        occurredAt,
        'status-unknown',
        `The UPS reports unrecognized status: ${current.status}`,
        'neutral',
        previous.status,
        current.status,
      ),
    );
  }
  return events;
}

function makeEvent(
  snapshot: UpsSnapshot,
  occurredAt: string,
  type: string,
  detail: string,
  tone: PowerEventInput['tone'],
  previousState: string | null,
  newState: string | null,
): PowerEventInput {
  const timeBucket = Math.floor(Date.parse(occurredAt) / 1000);
  return {
    deviceId: snapshot.deviceId,
    occurredAt,
    type,
    detail,
    tone,
    previousState,
    newState,
    transitionKey: `${snapshot.deviceId}:${type}:${previousState ?? '-'}:${newState ?? '-'}:${timeBucket}`,
  };
}
