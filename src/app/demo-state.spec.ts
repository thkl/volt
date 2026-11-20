import { DemoState } from './demo-state';

describe('DemoState', () => {
  let state: DemoState;

  beforeEach(() => {
    state = new DemoState();
  });

  it('starts in the online state with measured demo values', () => {
    expect(state.snapshot().flow).toBe('online');
    expect(state.snapshot().realPower).toBe(186);
    expect(state.statusText()).toBe('System online');
  });

  it('shows utility power while the battery is charging', () => {
    state.selectScenario('charging');

    expect(state.snapshot().flow).toBe('online');
    expect(state.snapshot().charging).toBe(true);
    expect(state.snapshot().statusTokens).toEqual(['OL', 'CHRG']);
    expect(state.snapshot().batteryCharge).toBe(82);
    expect(state.statusText()).toBe('System online');
  });

  it('retains battery flow while showing the low-battery flag separately', () => {
    state.selectScenario('low-battery');

    expect(state.snapshot().flow).toBe('battery');
    expect(state.snapshot().statusTokens).toEqual(['OB', 'LB']);
    expect(state.snapshot().lowBattery).toBe(true);
    expect(state.statusText()).toBe('Low battery');
  });

  it('marks stale data and leaves the last observed timestamp visible', () => {
    state.selectScenario('stale');

    expect(state.snapshot().flow).toBe('stale');
    expect(state.snapshot().observedAt).toBe('14 min ago');
    expect(state.statusText()).toBe('Data stale');
  });

  it('does not infer a flow state from an unrecognized status', () => {
    state.selectScenario('unknown');

    expect(state.snapshot().flow).toBe('unknown');
    expect(state.snapshot().status).toBe('CAL');
    expect(state.statusText()).toBe('Status unknown');
  });

  it('preserves missing sensors while keeping load percentage available', () => {
    state.selectScenario('missing-sensors');

    expect(state.snapshot().batteryCharge).toBeNull();
    expect(state.snapshot().runtimeSeconds).toBeNull();
    expect(state.snapshot().inputVoltage).toBeNull();
    expect(state.snapshot().loadPercent).toBe(24);
  });

  it('switches devices without changing the selected status scenario', () => {
    state.selectScenario('on-battery');
    state.selectDevice('network-closet');

    expect(state.selectedDevice().name).toBe('Network closet');
    expect(state.snapshot().flow).toBe('battery');
    expect(state.snapshot().realPower).toBe(150);
  });
});
