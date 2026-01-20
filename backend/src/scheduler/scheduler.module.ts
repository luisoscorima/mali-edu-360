// src/scheduler/scheduler.module.ts
import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { SchedulerService } from './scheduler.service';
import { Recording } from '../recordings/entities/recording.entity';
import { DriveModule } from '../drive/drive.module';

@Module({
  imports: [TypeOrmModule.forFeature([Recording]), DriveModule],
  providers: [SchedulerService]
})
export class SchedulerModule {}
