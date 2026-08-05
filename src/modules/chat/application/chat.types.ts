import { TeamMemberView } from '@shared/types/user.types';

export interface ChatMessageView {
  id: string;
  fromUserId: string;
  toUserId: string;
  body: string;
  mine: boolean;
  read: boolean;
  createdAt: string;
}

export interface ChatContactView extends TeamMemberView {
  role: string;
}

export interface ChatThreadView extends ChatContactView {
  lastMessage: ChatMessageView | null;
  unreadCount: number;
}
