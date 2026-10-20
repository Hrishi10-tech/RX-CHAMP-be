import { Module } from '@nestjs/common';
import { SettingsModule } from '@modules/settings/settings.module';
import { CalendarService } from './application/calendar.service';
import { CalendarController } from './presentation/calendar.controller';

/** Organisation calendars: working days, holidays, monthly working-day counts (4.0). */
@Module({
  imports: [SettingsModule],
  controllers: [CalendarController],
  providers: [CalendarService],
  exports: [CalendarService],
})
export class CalendarModule {}
