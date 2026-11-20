export const DATA_SOURCE_TYPES = [
    { type: 'demo', label: 'Demo simulator', implemented: true },
    { type: 'nut', label: 'Network UPS Tools', implemented: true },
    { type: 'mqtt', label: 'MQTT', implemented: false },
    { type: 'homeassistant', label: 'Home Assistant', implemented: false },
    { type: 'unifi-http', label: 'UniFi UPS HTTP API', implemented: false },
];
export const DEMO_SCENARIOS = [
    { id: 'online', label: 'Online · grid' },
    { id: 'charging', label: 'Charging · utility' },
    { id: 'on-battery', label: 'On battery' },
    { id: 'low-battery', label: 'Low battery' },
    { id: 'stale', label: 'Stale data' },
    { id: 'unknown', label: 'Unknown status' },
    { id: 'missing-sensors', label: 'Missing sensors' },
];
export const HISTORY_RANGES = ['1h', '24h', '7d', '30d'];
export const OUTAGE_RANGES = ['24h', '7d', '30d', '90d'];
export const HISTORY_METRICS = [
    'realPower',
    'loadPercent',
    'batteryCharge',
    'inputVoltage',
    'outputVoltage',
];
