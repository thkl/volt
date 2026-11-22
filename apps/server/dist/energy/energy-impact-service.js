const SETTINGS_KEY = 'energy-impact';
const DEFAULT_SETTINGS = {
    pricePerKwh: null,
    currency: 'EUR',
    carbonIntensityGramsPerKwh: null,
};
const DAYPARTS = [
    { id: 'night', label: 'Night', hours: '22:00–06:00' },
    { id: 'morning', label: 'Morning', hours: '06:00–12:00' },
    { id: 'afternoon', label: 'Afternoon', hours: '12:00–18:00' },
    { id: 'evening', label: 'Evening', hours: '18:00–22:00' },
];
const LOCAL_BOUNDARY_HOURS = [0, 6, 12, 18, 22];
export class EnergyImpactConfigurationError extends Error {
}
export class EnergyImpactService {
    store;
    sampleIntervalMs;
    settings;
    constructor(store, sampleIntervalMs) {
        this.store = store;
        this.sampleIntervalMs = sampleIntervalMs;
        this.settings = this.readSettings();
    }
    getSettings() {
        return { ...this.settings };
    }
    saveSettings(input) {
        const settings = parseSettings(input);
        this.store.setAppSetting(SETTINGS_KEY, JSON.stringify({ version: 1, settings }));
        this.settings = settings;
        return this.getSettings();
    }
    getImpact(deviceId, requestedTimeZone, now = Date.now()) {
        const timeZone = validateTimeZone(requestedTimeZone);
        const formatter = new Intl.DateTimeFormat('en-US', {
            timeZone,
            year: 'numeric',
            month: '2-digit',
            day: '2-digit',
            hour: '2-digit',
            minute: '2-digit',
            hourCycle: 'h23',
        });
        const from30Days = now - 30 * 24 * 60 * 60_000;
        const currentDate = localDateParts(now, formatter);
        const today = dateKey(currentDate);
        const todayStart = localTimeToEpoch(currentDate, 0, 0, formatter);
        const boundaries = localBoundaries(from30Days, now, formatter);
        const maxGapMs = Math.max(60_000, this.sampleIntervalMs * 2);
        const samples = this.store.getPowerSamples(deviceId, from30Days, now);
        const segments = buildSegments(samples, from30Days, now, maxGapMs, boundaries, formatter);
        const lastHourStart = now - 60 * 60_000;
        const lastDayStart = now - 24 * 60 * 60_000;
        const dayparts = DAYPARTS.map((daypart) => {
            const accumulator = sumSegments(segments.filter((segment) => segment.date === today && segment.daypart === daypart.id));
            return {
                ...daypart,
                ...toImpact(accumulator, elapsedDaypartMs(daypart.id, currentDate, todayStart, now, formatter), this.settings),
            };
        });
        const segmentsByDate = new Map();
        for (const segment of segments) {
            const day = segmentsByDate.get(segment.date) ?? [];
            day.push(segment);
            segmentsByDate.set(segment.date, day);
        }
        const dailyTrend = localDates(localDateParts(from30Days, formatter), currentDate).map((date) => {
            const key = dateKey(date);
            const accumulator = sumSegments(segmentsByDate.get(key) ?? []);
            const nextDate = addLocalDays(date, 1);
            const dayStart = localTimeToEpoch(date, 0, 0, formatter);
            const dayEnd = localTimeToEpoch(nextDate, 0, 0, formatter);
            const windowStart = Math.max(from30Days, dayStart);
            const windowEnd = Math.min(now, dayEnd);
            const duration = Math.max(0, windowEnd - windowStart);
            return { date: key, ...toImpact(accumulator, duration, this.settings) };
        });
        return {
            deviceId,
            timeZone,
            currency: this.settings.currency,
            pricePerKwh: this.settings.pricePerKwh,
            carbonIntensityGramsPerKwh: this.settings.carbonIntensityGramsPerKwh,
            maxGapSeconds: Math.round(maxGapMs / 1000),
            periods: {
                lastHour: summarizeWindow(segments, lastHourStart, now, this.settings),
                last24Hours: summarizeWindow(segments, lastDayStart, now, this.settings),
                last30Days: summarizeWindow(segments, from30Days, now, this.settings),
            },
            dayparts,
            dailyTrend,
        };
    }
    readSettings() {
        const raw = this.store.getAppSetting(SETTINGS_KEY);
        if (!raw)
            return { ...DEFAULT_SETTINGS };
        try {
            const value = JSON.parse(raw);
            if (!isRecord(value) || value['version'] !== 1 || !isRecord(value['settings'])) {
                throw new Error('Invalid saved settings');
            }
            return parseSettings(value['settings']);
        }
        catch {
            console.error(JSON.stringify({
                level: 'error',
                message: 'Saved energy impact settings could not be read; using defaults',
            }));
            return { ...DEFAULT_SETTINGS };
        }
    }
}
function parseSettings(value) {
    if (!isRecord(value) ||
        !isOptionalNumber(value['pricePerKwh']) ||
        !isOptionalNumber(value['carbonIntensityGramsPerKwh']) ||
        typeof value['currency'] !== 'string') {
        throw new EnergyImpactConfigurationError('Energy cost settings are invalid');
    }
    const currency = value['currency'].trim().toUpperCase();
    if (!/^[A-Z]{3}$/.test(currency) ||
        (value['pricePerKwh'] !== null && (value['pricePerKwh'] < 0 || value['pricePerKwh'] > 1000)) ||
        (value['carbonIntensityGramsPerKwh'] !== null &&
            (value['carbonIntensityGramsPerKwh'] < 0 || value['carbonIntensityGramsPerKwh'] > 5000))) {
        throw new EnergyImpactConfigurationError('Enter a valid currency, electricity price, and CO₂ intensity');
    }
    return {
        pricePerKwh: value['pricePerKwh'],
        currency,
        carbonIntensityGramsPerKwh: value['carbonIntensityGramsPerKwh'],
    };
}
function buildSegments(samples, fromMs, toMs, maxGapMs, boundaries, formatter) {
    const segments = [];
    for (let index = 1; index < samples.length; index += 1) {
        const previous = samples[index - 1];
        const current = samples[index];
        if (!previous || !current)
            continue;
        const intervalMs = current.observedAtMs - previous.observedAtMs;
        if (intervalMs <= 0 ||
            intervalMs > maxGapMs ||
            previous.realPower === null ||
            current.realPower === null ||
            !Number.isFinite(previous.realPower) ||
            !Number.isFinite(current.realPower)) {
            continue;
        }
        const startMs = Math.max(fromMs, previous.observedAtMs);
        const endMs = Math.min(toMs, current.observedAtMs);
        if (endMs <= startMs)
            continue;
        const startWatts = powerAt(previous, current, startMs);
        const endWatts = powerAt(previous, current, endMs);
        const cuts = cutsBetween(startMs, endMs, boundaries);
        for (let cut = 1; cut < cuts.length; cut += 1) {
            const segmentStart = cuts[cut - 1];
            const segmentEnd = cuts[cut];
            if (segmentStart === undefined || segmentEnd === undefined || segmentEnd <= segmentStart) {
                continue;
            }
            const midpoint = segmentStart + (segmentEnd - segmentStart) / 2;
            const local = zonedParts(midpoint, formatter);
            segments.push({
                startMs: segmentStart,
                endMs: segmentEnd,
                startWatts: interpolate(startWatts, endWatts, (segmentStart - startMs) / (endMs - startMs)),
                endWatts: interpolate(startWatts, endWatts, (segmentEnd - startMs) / (endMs - startMs)),
                estimated: previous.powerEstimated || current.powerEstimated,
                date: dateKey(local),
                daypart: daypartForHour(local.hour),
            });
        }
    }
    return segments;
}
function summarizeWindow(segments, fromMs, toMs, settings) {
    const clipped = { energyKwh: 0, estimatedEnergyKwh: 0, coveredMs: 0 };
    for (const segment of segments) {
        const start = Math.max(fromMs, segment.startMs);
        const end = Math.min(toMs, segment.endMs);
        if (end <= start)
            continue;
        const startWatts = powerAtSegment(segment, start);
        const endWatts = powerAtSegment(segment, end);
        accumulate(clipped, ((Math.max(0, startWatts) + Math.max(0, endWatts)) * 0.5 * ((end - start) / 3_600_000)) /
            1000, end - start, segment.estimated);
    }
    return toImpact(clipped, toMs - fromMs, settings);
}
function sumSegments(segments) {
    const result = { energyKwh: 0, estimatedEnergyKwh: 0, coveredMs: 0 };
    for (const segment of segments) {
        const energyKwh = ((Math.max(0, segment.startWatts) + Math.max(0, segment.endWatts)) *
            0.5 *
            ((segment.endMs - segment.startMs) / 3_600_000)) /
            1000;
        accumulate(result, energyKwh, segment.endMs - segment.startMs, segment.estimated);
    }
    return result;
}
function toImpact(accumulator, periodMs, settings) {
    const hasData = accumulator.coveredMs > 0;
    const energyKwh = hasData ? round(accumulator.energyKwh) : null;
    return {
        energyKwh,
        estimatedEnergyKwh: round(accumulator.estimatedEnergyKwh),
        cost: energyKwh !== null && settings.pricePerKwh !== null
            ? round(energyKwh * settings.pricePerKwh)
            : null,
        co2Kg: energyKwh !== null && settings.carbonIntensityGramsPerKwh !== null
            ? round((energyKwh * settings.carbonIntensityGramsPerKwh) / 1000)
            : null,
        coveragePercent: periodMs > 0 ? Math.min(100, round((accumulator.coveredMs / periodMs) * 100, 1)) : 0,
    };
}
function accumulate(accumulator, energyKwh, coveredMs, estimated) {
    accumulator.energyKwh += energyKwh;
    if (estimated)
        accumulator.estimatedEnergyKwh += energyKwh;
    accumulator.coveredMs += coveredMs;
}
function localBoundaries(fromMs, toMs, formatter) {
    const firstDate = addLocalDays(localDateParts(fromMs, formatter), -1);
    const lastDate = addLocalDays(localDateParts(toMs, formatter), 1);
    const boundaries = [];
    for (const date of localDates(firstDate, lastDate)) {
        for (const hour of LOCAL_BOUNDARY_HOURS) {
            const boundary = localTimeToEpoch(date, hour, 0, formatter);
            if (boundary > fromMs && boundary < toMs)
                boundaries.push(boundary);
        }
    }
    return boundaries.sort((left, right) => left - right);
}
function cutsBetween(startMs, endMs, boundaries) {
    let low = 0;
    let high = boundaries.length;
    while (low < high) {
        const middle = Math.floor((low + high) / 2);
        if ((boundaries[middle] ?? Number.POSITIVE_INFINITY) <= startMs)
            low = middle + 1;
        else
            high = middle;
    }
    const cuts = [startMs];
    for (let index = low; index < boundaries.length; index += 1) {
        const boundary = boundaries[index];
        if (boundary === undefined || boundary >= endMs)
            break;
        cuts.push(boundary);
    }
    cuts.push(endMs);
    return cuts;
}
function localDates(start, end) {
    const dates = [];
    let cursor = start;
    while (compareDates(cursor, end) <= 0) {
        dates.push(cursor);
        cursor = addLocalDays(cursor, 1);
    }
    return dates;
}
function elapsedDaypartMs(id, date, dayStart, now, formatter) {
    const morning = localTimeToEpoch(date, 6, 0, formatter);
    const afternoon = localTimeToEpoch(date, 12, 0, formatter);
    const evening = localTimeToEpoch(date, 18, 0, formatter);
    const night = localTimeToEpoch(date, 22, 0, formatter);
    switch (id) {
        case 'night':
            return Math.max(0, Math.min(now, morning) - dayStart) + Math.max(0, now - night);
        case 'morning':
            return Math.max(0, Math.min(now, afternoon) - morning);
        case 'afternoon':
            return Math.max(0, Math.min(now, evening) - afternoon);
        case 'evening':
            return Math.max(0, Math.min(now, night) - evening);
    }
}
function localDateParts(timestamp, formatter) {
    const { year, month, day } = zonedParts(timestamp, formatter);
    return { year, month, day };
}
function zonedParts(timestamp, formatter) {
    const parts = formatter.formatToParts(new Date(timestamp));
    const value = (type) => Number(parts.find((part) => part.type === type)?.value ?? 0);
    return {
        year: value('year'),
        month: value('month'),
        day: value('day'),
        hour: value('hour'),
        minute: value('minute'),
    };
}
function localTimeToEpoch(date, hour, minute, formatter) {
    const day = hour === 24 ? addLocalDays(date, 1) : date;
    const normalizedHour = hour === 24 ? 0 : hour;
    const desiredWallTime = Date.UTC(day.year, day.month - 1, day.day, normalizedHour, minute);
    let guess = desiredWallTime;
    for (let attempt = 0; attempt < 4; attempt += 1) {
        const local = zonedParts(guess, formatter);
        const observedWallTime = Date.UTC(local.year, local.month - 1, local.day, local.hour, local.minute);
        const correction = desiredWallTime - observedWallTime;
        if (correction === 0)
            break;
        guess += correction;
    }
    return guess;
}
function addLocalDays(date, days) {
    const next = new Date(Date.UTC(date.year, date.month - 1, date.day + days));
    return { year: next.getUTCFullYear(), month: next.getUTCMonth() + 1, day: next.getUTCDate() };
}
function dateKey(date) {
    return `${date.year}-${String(date.month).padStart(2, '0')}-${String(date.day).padStart(2, '0')}`;
}
function daypartForHour(hour) {
    if (hour < 6 || hour >= 22)
        return 'night';
    if (hour < 12)
        return 'morning';
    if (hour < 18)
        return 'afternoon';
    return 'evening';
}
function compareDates(left, right) {
    return (Date.UTC(left.year, left.month - 1, left.day) - Date.UTC(right.year, right.month - 1, right.day));
}
function powerAt(previous, current, timestamp) {
    const startWatts = Math.max(0, previous.realPower ?? 0);
    const endWatts = Math.max(0, current.realPower ?? 0);
    const proportion = (timestamp - previous.observedAtMs) / (current.observedAtMs - previous.observedAtMs);
    return interpolate(startWatts, endWatts, proportion);
}
function powerAtSegment(segment, timestamp) {
    const proportion = (timestamp - segment.startMs) / (segment.endMs - segment.startMs);
    return interpolate(segment.startWatts, segment.endWatts, proportion);
}
function interpolate(start, end, proportion) {
    return start + (end - start) * proportion;
}
function validateTimeZone(value) {
    const timeZone = value.trim() || 'UTC';
    if (timeZone.length > 100) {
        throw new EnergyImpactConfigurationError('The selected time zone is invalid');
    }
    try {
        new Intl.DateTimeFormat('en-US', { timeZone });
        return timeZone;
    }
    catch {
        throw new EnergyImpactConfigurationError('The selected time zone is invalid');
    }
}
function isOptionalNumber(value) {
    return value === null || (typeof value === 'number' && Number.isFinite(value));
}
function isRecord(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function round(value, decimals = 6) {
    const factor = 10 ** decimals;
    return Math.round(value * factor) / factor;
}
