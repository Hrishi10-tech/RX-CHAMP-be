import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { LoggerModule as PinoLoggerModule } from 'nestjs-pino';

@Module({
  imports: [
    PinoLoggerModule.forRootAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        pinoHttp: {
          level: config.get<string>('logLevel') ?? 'info',
          transport:
            config.get<string>('env') !== 'production'
              ? { target: 'pino-pretty', options: { singleLine: true, colorize: true } }
              : undefined,
          redact: ['req.headers.authorization', 'req.body.password', 'req.body.passwordHash'],
          autoLogging: true,
          customProps: () => ({ context: 'HTTP' }),
        },
      }),
    }),
  ],
  exports: [PinoLoggerModule],
})
export class AppLoggerModule {}
