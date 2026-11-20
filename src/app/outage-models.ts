export const OUTAGE_RANGES = ['24h', '7d', '30d', '90d'] as const;
export type OutageRange = (typeof OUTAGE_RANGES)[number];

export interface OutageEpisode {
  id: number | null;
  startedAt: string | null;
  endedAt: string | null;
  durationMs: number | null;
  status: 'completed' | 'ongoing' | 'uncertain';
  uncertainty: 'connection-gap' | 'missing-start' | 'missing-return' | null;
}

export interface OutageSummary {
  deviceId: string;
  range: OutageRange;
  from: string;
  to: string;
  outageCount: number;
  completedCount: number;
  uncertainCount: number;
  confirmedDurationMs: number;
  longestConfirmedDurationMs: number | null;
  outages: OutageEpisode[];
}
