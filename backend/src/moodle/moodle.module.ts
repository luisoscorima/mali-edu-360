import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { MoodleService } from './moodle.service';

@Module({
  imports: [ConfigModule],
  providers: [MoodleService],
  exports: [MoodleService],
})
export class MoodleModule {}
