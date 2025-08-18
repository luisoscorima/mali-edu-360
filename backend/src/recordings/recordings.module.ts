import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { RecordingsService } from './recordings.service';
import { DriveModule } from '../drive/drive.module';
import { MoodleModule } from '../moodle/moodle.module';
import { Recording } from './entities/recording.entity';
import { Meeting } from '../meetings/entities/meeting.entity';
import { ZoomLicensesModule } from 'src/zoom-licenses/zoom-licenses.module';
import { ZoomService } from 'src/meetings/zoom.service';

@Module({
  imports: [TypeOrmModule.forFeature([Recording, Meeting]), DriveModule, MoodleModule, ZoomLicensesModule],
  providers: [RecordingsService, ZoomService],
  exports: [RecordingsService],
})
export class RecordingsModule {}
