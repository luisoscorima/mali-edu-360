import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { MeetingsController } from './meetings.controller';
import { MeetingsService } from './meetings.service';
import { Meeting } from './entities/meeting.entity';
import { ZoomService } from './zoom.service';
import { ZoomLicensesModule } from 'src/zoom-licenses/zoom-licenses.module';
import { ZoomWebhookController } from './zoom-webhook.controller';
import { RecordingsModule } from 'src/recordings/recordings.module';

@Module({
  imports: [TypeOrmModule.forFeature([Meeting]), ZoomLicensesModule, RecordingsModule],
  controllers: [MeetingsController, ZoomWebhookController],
  providers: [MeetingsService, ZoomService],
})
export class MeetingsModule {}
