import { Component, inject } from '@angular/core';
import { HistoryChart } from '../../components/history-chart/history-chart';
import { DemoState } from '../../demo-state';

@Component({
  imports: [HistoryChart],
  selector: 'app-history-page',
  styleUrl: './history-page.css',
  templateUrl: './history-page.html',
})
export class HistoryPage {
  readonly state = inject(DemoState);
}
