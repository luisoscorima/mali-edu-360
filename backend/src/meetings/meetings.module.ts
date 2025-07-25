import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { MeetingsController } from './meetings.controller';
import { MeetingsService } from './meetings.service';
import { Meeting } from './entities/meeting.entity';
import { ZoomService } from './zoom.service';
import { ZoomLicensesModule } from 'src/zoom-licenses/zoom-licenses.module';

@Module({
  imports: [TypeOrmModule.forFeature([Meeting]), ZoomLicensesModule],
  controllers: [MeetingsController],
  providers: [MeetingsService, ZoomService],
})
export class MeetingsModule {}
