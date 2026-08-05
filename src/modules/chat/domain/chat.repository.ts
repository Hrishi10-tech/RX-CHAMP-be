export const CHAT_REPOSITORY = Symbol('CHAT_REPOSITORY');

export interface ChatMessageRecord {
  id: string;
  fromUserId: string;
  toUserId: string;
  body: string;
  readAt: Date | null;
  createdAt: Date;
}

export interface CreateMessageData {
  fromUserId: string;
  toUserId: string;
  body: string;
}


export interface ThreadSummary {
  otherId: string;
  lastMessage: ChatMessageRecord | null;
  unreadCount: number;
}

export interface ChatRepository {
  create(data: CreateMessageData): Promise<ChatMessageRecord>;
  /** Messages exchanged between two users, oldest→newest, capped at `take`. */
  listConversation(userA: string, userB: string, take: number): Promise<ChatMessageRecord[]>;
  /** Marks messages sent by `fromUserId` to `userId` as read; returns how many changed. */
  markRead(userId: string, fromUserId: string): Promise<number>;
  /** Total unread messages addressed to the user. */
  countUnread(userId: string): Promise<number>;
  /** Last message + unread count between `meId` and each of `otherIds`. */
  threadSummaries(meId: string, otherIds: string[]): Promise<ThreadSummary[]>;
}
