import { PaginatedResult } from '@shared/types/pagination.types';

export interface NotificationView {
  id: string;
  type: string;
  title: string;
  body: string | null;
  read: boolean;
  readAt: string | null;
  createdAt: string;
}

export type ListNotificationsResult = PaginatedResult<'notifications', NotificationView> & {
  unread: number;
};
