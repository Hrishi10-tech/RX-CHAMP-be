import { Injectable } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { WORKDAY_GATE, WorkdayGate } from '@shared/tenancy/workday-gate.port';

/**
 * The worktime module's "day must be open" rule for /presence/start and /end
 * (re-audit M3). Worktime depends on presence, so the gate is looked up at run
 * time rather than injected.
 */
@Injectable()
export class PresenceDayGate {
  private gate: WorkdayGate | null = null;

  constructor(private readonly moduleRef: ModuleRef) {}

  /** The open session (its working day), the 409 of a closed day, or null without the gate. */
  async ensureOpen(
    userId: string,
    generation: 'AGENT_31' | 'LEGACY',
    now: Date,
  ): Promise<{ date: string; startedAt: Date } | null> {
    if (!this.gate) {
      try {
        this.gate = this.moduleRef.get<WorkdayGate>(WORKDAY_GATE, { strict: false });
      } catch {
        return null;
      }
    }
    return this.gate.ensureOpen(userId, generation, now);
  }
}
