import { Module } from '@nestjs/common';
import { DriveService } from './drive.service';
import { ConfigModule } from '@nestjs/config';

@Module({
  imports: [ConfigModule],
  providers: [DriveService],
  exports: [DriveService],
})
export class DriveModule {}
