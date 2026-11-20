export type ShutdownCoordination = 'unverified' | 'verified' | 'not_configured';

export interface ShutdownReadinessPlan {
  deviceId: string;
  dependentSystems: string[];
  coordination: ShutdownCoordination;
  updatedAt: string | null;
}

export interface ShutdownReadinessPlanInput {
  dependentSystems: string[];
  coordination: ShutdownCoordination;
}
