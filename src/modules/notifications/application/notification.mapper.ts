import { NotificationRecord } from '../domain/notification.repository';
import { NotificationView } from './notification.types';

export class NotificationMapper {
  static toView(n: NotificationRecord): NotificationView {
    return {
      id: n.id,
      type: n.type,
      title: n.title,
      body: n.body,
      read: n.readAt !== null,
      readAt: n.readAt ? n.readAt.toISOString() : null,
      createdAt: n.createdAt.toISOString(),
    };
  }
}
