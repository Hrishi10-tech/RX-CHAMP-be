export const INTEGRATION_PERIODS_READER = Symbol('INTEGRATION_PERIODS_READER');

/**
 * A stretch of days an organisation's biometric integration was on (3.6). The biometric
 * module writes them; 4.0: each organisation runs its own integration, so each has its own.
 */
export interface IntegrationPeriodLite {
  /** First business day it was on. */
  fromDate: string;
  /** Last business day it was on; null while it is on. */
  toDate: string | null;
}

/** A stretch someone was on biometric before moving back to the agent (3.6). */
export interface BiometricStretchLite {
  /** First business day on biometric; null when that was never recorded (from the beginning). */
  fromDate: string | null;
  /** Last business day on biometric. */
  toDate: string;
}

export interface IntegrationPeriodsReader {
  /**
   * 4.0: these organisations' periods, oldest first, by organisation id. An organisation
   * whose integration was never on has no entry (its biometric staff stay paused).
   */
  list(companyIds: string[]): Promise<Map<string, IntegrationPeriodLite[]>>;
  /** These people's earlier stretches on biometric, by person; no entry with none. */
  biometricStretches(userIds: string[]): Promise<Map<string, BiometricStretchLite[]>>;
}
