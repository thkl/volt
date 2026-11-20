import { Component, inject } from '@angular/core';
import { DemoState } from '../../demo-state';

@Component({
  imports: [],
  selector: 'app-events-page',
  styleUrl: './events-page.css',
  templateUrl: './events-page.html',
})
export class EventsPage {
  readonly state = inject(DemoState);
}
