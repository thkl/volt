import { EventEmitter } from 'node:events';
export class IngestionService extends EventEmitter {
    store;
    options;
    constructor(store, options) {
        super();
        this.store = store;
        this.options = options;
    }
    ingest(snapshot, description = snapshot.deviceName) {
        const previous = this.store.getDevice(snapshot.deviceId)?.snapshot ?? null;
        const events = previous ? detectTransitions(previous, snapshot, new Date().toISOString()) : [];
        const observedAtMs = Date.parse(snapshot.observedAt);
        const lastSampleAt = this.store.getLastSampleAt(snapshot.deviceId);
        const includeSample = lastSampleAt === null ||
            events.length > 0 ||
            (snapshot.freshness === 'fresh' &&
                observedAtMs - lastSampleAt >= this.options.sampleIntervalMs);
        this.store.writeObservation(snapshot, description, this.options.hostId, events, includeSample);
        this.emit('snapshot', snapshot, events);
    }
    markUnavailable(deviceId, detail, freshness = 'stale') {
        const device = this.store.getDevice(deviceId);
        const previous = device?.snapshot;
        if (!device || !previous || previous.freshness !== 'fresh')
            return;
        const now = new Date().toISOString();
        const snapshot = {
            ...previous,
            flow: 'stale',
            freshness,
        };
        const event = makeEvent(snapshot, now, 'connection-lost', detail, 'neutral', previous.freshness, freshness);
        this.store.writeObservation(snapshot, device.description, this.options.hostId, [event], false);
        this.emit('snapshot', snapshot, [event]);
    }
}
function detectTransitions(previous, current, occurredAt) {
    const events = [];
    if (previous.freshness === 'fresh' && current.freshness !== 'fresh') {
        events.push(makeEvent(current, occurredAt, 'connection-lost', 'No successful poll in three intervals', 'neutral', previous.freshness, current.freshness));
    }
    if (previous.freshness !== 'fresh' && current.freshness === 'fresh') {
        events.push(makeEvent(current, occurredAt, 'connection-restored', 'The UPS is reporting data again', 'good', previous.freshness, current.freshness));
    }
    if (previous.flow !== current.flow && current.flow === 'battery') {
        events.push(makeEvent(current, occurredAt, 'on-battery', 'The UPS reports battery power', 'warning', previous.flow, current.flow));
    }
    else if (previous.flow === 'battery' && current.flow === 'online') {
        events.push(makeEvent(current, occurredAt, 'mains-restored', 'Power returned to utility supply', 'good', previous.flow, current.flow));
    }
    if (!previous.lowBattery && current.lowBattery) {
        events.push(makeEvent(current, occurredAt, 'low-battery', 'The UPS reports the LB status flag', 'critical', 'normal', 'low'));
    }
    else if (previous.lowBattery && !current.lowBattery) {
        events.push(makeEvent(current, occurredAt, 'battery-normal', 'The UPS cleared the LB status flag', 'good', 'low', 'normal'));
    }
    if (previous.flow !== 'unknown' && current.flow === 'unknown' && current.freshness === 'fresh') {
        events.push(makeEvent(current, occurredAt, 'status-unknown', `The UPS reports unrecognized status: ${current.status}`, 'neutral', previous.status, current.status));
    }
    return events;
}
function makeEvent(snapshot, occurredAt, type, detail, tone, previousState, newState) {
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
