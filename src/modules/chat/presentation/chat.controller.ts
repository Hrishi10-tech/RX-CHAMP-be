import { Body, Controller, Get, HttpCode, Post, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '@shared/rbac/jwt-auth.guard';
import { CurrentUser } from '@shared/rbac/current-user.decorator';
import { AuthenticatedUser } from '@shared/rbac/authenticated-user';
import { envelope } from '@shared/http/envelope';
import { ConversationQueryDto, SendMessageDto } from '../application/dto';
import { SendMessageUseCase } from '../application/use-cases/send-message.use-case';
import { GetConversationUseCase } from '../application/use-cases/get-conversation.use-case';
import { ListContactsUseCase } from '../application/use-cases/list-contacts.use-case';
import { ListThreadsUseCase } from '../application/use-cases/list-threads.use-case';
import { GetUnreadCountUseCase } from '../application/use-cases/get-unread-count.use-case';

@ApiTags('chat')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('chat')
export class ChatController {
  constructor(
    private readonly sendMessage: SendMessageUseCase,
    private readonly getConversation: GetConversationUseCase,
    private readonly listContacts: ListContactsUseCase,
    private readonly listThreads: ListThreadsUseCase,
    private readonly unreadCount: GetUnreadCountUseCase,
  ) {}

  @Get('contacts')
  @ApiOperation({ summary: 'People the signed-in user can message (manager, reports, teammates)' })
  async contacts(@CurrentUser() me: AuthenticatedUser) {
    return envelope(await this.listContacts.execute(me.id));
  }

  @Get('threads')
  @ApiOperation({ summary: 'Conversation list: each contact with last-message preview + unread count' })
  async threads(@CurrentUser() me: AuthenticatedUser) {
    return envelope(await this.listThreads.execute(me.id));
  }

  @Get('unread')
  @ApiOperation({ summary: 'Total unread messages addressed to the signed-in user' })
  async unread(@CurrentUser() me: AuthenticatedUser) {
    return envelope(await this.unreadCount.execute(me.id));
  }

  @Get('messages')
  @ApiOperation({ summary: 'Conversation with another user (marks their messages read)' })
  async conversation(@CurrentUser() me: AuthenticatedUser, @Query() query: ConversationQueryDto) {
    return envelope(await this.getConversation.execute(me.id, query));
  }

  @Post('messages')
  @HttpCode(201)
  @ApiOperation({ summary: 'Send a message to another user' })
  async send(@CurrentUser() me: AuthenticatedUser, @Body() body: SendMessageDto) {
    return envelope(await this.sendMessage.execute(me.id, body));
  }
}
