import { fullName } from '@shared/types/user.types';
import { ChatContact } from '../domain/chat-contacts.reader';
import { ChatMessageRecord, ThreadSummary } from '../domain/chat.repository';
import { ChatContactView, ChatMessageView, ChatThreadView } from './chat.types';

export class ChatMapper {
  static toMessageView(m: ChatMessageRecord, meId: string): ChatMessageView {
    return {
      id: m.id,
      fromUserId: m.fromUserId,
      toUserId: m.toUserId,
      body: m.body,
      mine: m.fromUserId === meId,
      read: m.readAt !== null,
      createdAt: m.createdAt.toISOString(),
    };
  }

  static toContactView(c: ChatContact): ChatContactView {
    return {
      userId: c.id,
      name: fullName(c),
      email: c.email,
      role: c.role,
      department: c.department,
    };
  }

  static toThreadView(
    c: ChatContact,
    summary: ThreadSummary | undefined,
    meId: string,
  ): ChatThreadView {
    return {
      ...this.toContactView(c),
      lastMessage: summary?.lastMessage ? this.toMessageView(summary.lastMessage, meId) : null,
      unreadCount: summary?.unreadCount ?? 0,
    };
  }
}
