import { Module } from '@nestjs/common';
import { RecordingsService } from './recordings.service';
import { RecordingsController } from './recordings.controller';
import { DriveModule } from '../drive/drive.module';
import { MoodleModule } from '../moodle/moodle.module';

@Module({
  imports: [
    DriveModule,
    MoodleModule,
  ],
  controllers: [RecordingsController],
  providers: [RecordingsService],
})
export class RecordingsModule {}
