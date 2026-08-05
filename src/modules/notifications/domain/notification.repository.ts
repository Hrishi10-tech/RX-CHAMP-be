import { PageFilter } from '@shared/types/pagination.types';

export const NOTIFICATION_REPOSITORY = Symbol('NOTIFICATION_REPOSITORY');

export interface NotificationRecord {
  id: string;
  userId: string;
  type: string;
  title: string;
  body: string | null;
  readAt: Date | null;
  createdAt: Date;
}

export interface CreateNotificationData {
  userId: string;
  type: string;
  title: string;
  body?: string | null;
}

export interface ListNotificationsFilter extends PageFilter {
  unreadOnly?: boolean;
}

export interface NotificationRepository {
  create(data: CreateNotificationData): Promise<NotificationRecord>;
  listForUser(userId: string, filter?: ListNotificationsFilter): Promise<NotificationRecord[]>;
  countForUser(userId: string, filter?: ListNotificationsFilter): Promise<number>;
  /** Marks one notification read, scoped to its owner. Returns null if it isn't theirs. */
  markRead(userId: string, id: string): Promise<NotificationRecord | null>;
  /** Marks every unread notification for the user read; returns how many changed. */
  markAllRead(userId: string): Promise<number>;
}
