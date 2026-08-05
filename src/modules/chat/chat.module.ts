import { Module } from '@nestjs/common';
import { CHAT_REPOSITORY } from './domain/chat.repository';
import { CHAT_CONTACTS_READER } from './domain/chat-contacts.reader';
import { PrismaChatRepository } from './infrastructure/prisma-chat.repository';
import { PrismaChatContactsReader } from './infrastructure/prisma-chat-contacts.reader';
import { SendMessageUseCase } from './application/use-cases/send-message.use-case';
import { GetConversationUseCase } from './application/use-cases/get-conversation.use-case';
import { ListContactsUseCase } from './application/use-cases/list-contacts.use-case';
import { ListThreadsUseCase } from './application/use-cases/list-threads.use-case';
import { GetUnreadCountUseCase } from './application/use-cases/get-unread-count.use-case';
import { ChatController } from './presentation/chat.controller';
import { ChatGateway } from './presentation/chat.gateway';

@Module({
  controllers: [ChatController],
  providers: [
    { provide: CHAT_REPOSITORY, useClass: PrismaChatRepository },
    { provide: CHAT_CONTACTS_READER, useClass: PrismaChatContactsReader },
    ChatGateway,
    SendMessageUseCase,
    GetConversationUseCase,
    ListContactsUseCase,
    ListThreadsUseCase,
    GetUnreadCountUseCase,
  ],
})
export class ChatModule {}
