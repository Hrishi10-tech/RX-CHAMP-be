import { Inject, Injectable, Logger } from '@nestjs/common';
import {
  AGENT_CONTACT_REPOSITORY,
  AgentContactRepository,
  UploadRefusal,
} from '../domain/agent-contact.repository';

/** A person's row is rewritten at most this often (the agent calls every minute). */
export const CONTACT_WRITE_INTERVAL_MS = 60_000;
/** The throttle map is cleared past this many people (a restart-safe bound). */
const MAX_TRACKED = 20_000;

/**
 * Records that a person's agent reached the server, and the uploads it was
 * refused. Everything here is best effort: a failure is logged, never thrown
 * into the agent's request.
 */
@Injectable()
export class AgentContactService {
  private readonly logger = new Logger(AgentContactService.name);
  private readonly lastWrite = new Map<string, { at: number; ua: string | null }>();

  constructor(@Inject(AGENT_CONTACT_REPOSITORY) private readonly repo: AgentContactRepository) {}

  /** The agent made a request. Writes through once a minute per person, or when the agent changes. */
  touch(userId: string, userAgent: string | null | undefined, now: Date = new Date()): void {
    const ua = userAgent ?? null;
    const prev = this.lastWrite.get(userId);
    if (prev && prev.ua === ua && now.getTime() - prev.at < CONTACT_WRITE_INTERVAL_MS) return;
    if (this.lastWrite.size >= MAX_TRACKED) this.lastWrite.clear();
    this.lastWrite.set(userId, { at: now.getTime(), ua });
    void this.repo.touch(userId, ua, now).catch((err: Error) => {
      this.lastWrite.delete(userId);
      this.logger.warn(`agent contact for ${userId} not recorded: ${err.message}`);
    });
  }

  /** An upload was turned away; the health view shows the last one and why. */
  refused(userId: string, refusal: Omit<UploadRefusal, 'at'>, now: Date = new Date()): void {
    this.lastWrite.set(userId, { at: now.getTime(), ua: this.lastWrite.get(userId)?.ua ?? null });
    void this.repo.recordRefusal(userId, { ...refusal, at: now }).catch((err: Error) => {
      this.logger.warn(`upload refusal for ${userId} not recorded: ${err.message}`);
    });
  }

  /** Tests and the health view in one process: what was last written. */
  forget(userId: string): void {
    this.lastWrite.delete(userId);
  }
}
