import { Routes } from '@angular/router';
import { EventsPage } from './pages/events-page/events-page';
import { BatteryHealthPage } from './pages/battery-health-page/battery-health-page';
import { HistoryPage } from './pages/history-page/history-page';
import { OverviewPage } from './pages/overview-page/overview-page';
import { OutagesPage } from './pages/outages-page/outages-page';

export const routes: Routes = [
  { path: '', component: OverviewPage, title: 'Volt · Overview' },
  { path: 'battery', component: BatteryHealthPage, title: 'Volt · Battery health' },
  { path: 'history', component: HistoryPage, title: 'Volt · History' },
  { path: 'outages', component: OutagesPage, title: 'Volt · Outages' },
  { path: 'events', component: EventsPage, title: 'Volt · Events' },
  { path: '**', redirectTo: '' },
];
