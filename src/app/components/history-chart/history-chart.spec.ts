import { TestBed } from '@angular/core/testing';
import type { ComponentFixture } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getDemoSnapshot } from '../../demo-data';
import { LiveUpdates } from '../../live-updates';
import { HistoryChart } from './history-chart';

describe('HistoryChart', () => {
  let fixture: ComponentFixture<HistoryChart>;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [HistoryChart],
      providers: [
        {
          provide: LiveUpdates,
          useValue: { getHistory: vi.fn(), getLatestHistoryReading: () => null },
        },
      ],
    }).compileComponents();
    fixture = TestBed.createComponent(HistoryChart);
    fixture.componentRef.setInput('snapshot', getDemoSnapshot('online', 'network-closet'));
    fixture.componentRef.setInput('scenario', 'online');
    fixture.detectChanges();
    await fixture.whenStable();
  });

  afterEach(() => vi.restoreAllMocks());

  it('shows power and voltage series for an online UPS', () => {
    const chart = fixture.componentInstance.chart();

    expect(chart).toMatchObject({
      primaryLabel: 'Power draw',
      primaryUnit: 'W',
      voltageAvailable: true,
      ariaLabel: 'Power draw history and input voltage for the last 24 hours',
    });
    expect(chart.primaryLine).toContain('M ');
    expect(chart.voltageLine).toContain('M ');
  });

  it('shows time and readings on pointer hover, then clears the tooltip outside the plot', () => {
    const chart = fixture.componentInstance;
    chart.moveTooltip({
      currentTarget: {
        getBoundingClientRect: () => ({ left: 100, top: 20, width: 1000, height: 242 }),
      },
      clientX: 500,
      clientY: 80,
    } as unknown as PointerEvent);

    expect(chart.hoverInfo()).toMatchObject({
      primaryLabel: 'Power draw',
      primaryUnit: 'W',
    });
    expect(chart.hoverInfo()?.time).toBeTruthy();
    expect(chart.hoverInfo()?.primaryValue).not.toBe('—');
    expect(chart.hoverInfo()?.voltageValue).not.toBe('—');

    chart.moveTooltip({
      currentTarget: {
        getBoundingClientRect: () => ({ left: 100, top: 20, width: 1000, height: 242 }),
      },
      clientX: 101,
      clientY: 80,
    } as unknown as PointerEvent);
    expect(chart.hoverInfo()).toBeNull();
  });
});
