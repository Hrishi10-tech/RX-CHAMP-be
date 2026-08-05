export interface HealthStatus {
  status: 'up';
  db: 'up' | 'down';
  uptimeSec: number;
}

export interface ProcessMetrics {
  uptimeSec: number;
  memory: {
    rssMb: number;
    heapUsedMb: number;
  };
  pid: number;
  nodeVersion: string;
}
