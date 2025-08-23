import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AdminRecordingsController } from './admin-recordings.controller';
import { AdminDebugController } from './admin-debug.controller';
import { AdminZoomController } from './admin-zoom.controller';
import { AdminTestController } from './admin-test.controller';
import { RecordingsModule } from '../recordings/recordings.module';
import { ZoomModule } from '../zoom/zoom.module';
import { MoodleModule } from '../moodle/moodle.module';
import { DriveModule } from '../drive/drive.module';
import { ZoomSyncService } from './zoom-sync.service';
import { Meeting } from '../meetings/entities/meeting.entity';
import { Recording } from '../recordings/entities/recording.entity';

@Module({
  imports: [
    RecordingsModule,
    ZoomModule,
    MoodleModule,
    DriveModule,
    TypeOrmModule.forFeature([Meeting, Recording]),
  ],
  controllers: [AdminRecordingsController, AdminDebugController, AdminZoomController, AdminTestController],
  providers: [ZoomSyncService],
})
export class AdminModule {}
