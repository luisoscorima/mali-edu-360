import { Module } from '@nestjs/common';
import { DriveService } from './drive.service';

@Module({
  providers: [DriveService]
})
export class DriveModule {}
