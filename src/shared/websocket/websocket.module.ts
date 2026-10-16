import { Global, Module } from '@nestjs/common';
import { SocketAccessService } from './socket-access.service';

@Global()
@Module({
  providers: [SocketAccessService],
  exports: [SocketAccessService],
})
export class WebsocketModule {}
