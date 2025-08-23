import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ZoomRecordingsService } from './zoom-recordings.service';

@Module({
  imports: [ConfigModule],
  providers: [ZoomRecordingsService],
  exports: [ZoomRecordingsService],
})
export class ZoomModule {}
