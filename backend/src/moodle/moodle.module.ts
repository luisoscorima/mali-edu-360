import { Module } from '@nestjs/common';
import { MoodleService } from './moodle.service';

@Module({
  providers: [MoodleService]
})
export class MoodleModule {}
