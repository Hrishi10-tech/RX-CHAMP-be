import { PaginatedResult } from '@shared/types/pagination.types';

export interface NotificationView {
  id: string;
  type: string;
  title: string;
  body: string | null;
  /** The person behind it (a chat sender, say); null when the system raised it. */
  fromUserId: string | null;
  read: boolean;
  readAt: string | null;
  createdAt: string;
}

export type ListNotificationsResult = PaginatedResult<'notifications', NotificationView> & {
  unread: number;
};
