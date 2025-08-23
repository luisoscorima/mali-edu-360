import { Controller, Post, Body, ValidationPipe, BadRequestException } from '@nestjs/common';
import { IsString, IsOptional, IsBoolean, IsNumber, IsDateString } from 'class-validator';
import { RecordingsService } from '../recordings/recordings.service';

export class RetryRequestDTO {
  @IsOptional()
  @IsString()
  zoomRecordingId?: string;

  @IsOptional()
  @IsString()
  meetingId?: string;

  @IsOptional()
  @IsString()
  zoomMeetingId?: string;

  @IsOptional()
  @IsDateString()
  from?: string; // ISO

  @IsOptional()
  @IsDateString()
  to?: string;   // ISO

  @IsOptional()
  @IsBoolean()
  republish?: boolean;

  @IsOptional()
  @IsBoolean()
  forceRedownload?: boolean;

  @IsOptional()
  @IsBoolean()
  forceRepost?: boolean;

  @IsOptional()
  @IsNumber()
  overrideCourseIdMoodle?: number;

  @IsOptional()
  @IsBoolean()
  dryRun?: boolean;

  @IsOptional()
  @IsNumber()
  limit?: number;
}

export interface RetryResult {
  selector: Record<string, any>;
  mode: 'full' | 'republish' | 'skipped';
  status: 'ok' | 'failed' | 'skipped';
  reason: string;
  meetingId?: string;
  zoomMeetingId?: string;
  courseIdMoodle?: number;
  driveUrl?: string;
  moodlePostId?: number;
  integrity?: {
    localMd5?: string;
    driveMd5?: string;
    sizeBytes?: number;
  };
}

@Controller('admin/recordings')
export class AdminRecordingsController {
  constructor(private readonly recordingsService: RecordingsService) {}

  @Post('retry')
  async retryRecordings(@Body(ValidationPipe) dto: RetryRequestDTO): Promise<RetryResult[]> {
    // Validar que hay exactamente un selector
    const selectors = [
      dto.zoomRecordingId ? 'zoomRecordingId' : null,
      dto.meetingId ? 'meetingId' : null,
      dto.zoomMeetingId ? 'zoomMeetingId' : null,
      (dto.from && dto.to) ? 'timeRange' : null,
    ].filter(Boolean);

    if (selectors.length === 0) {
      throw new BadRequestException('Debe proporcionar exactamente un selector: zoomRecordingId, meetingId, zoomMeetingId, o from+to');
    }
    if (selectors.length > 1) {
      throw new BadRequestException('Solo se permite un tipo de selector por request');
    }

    if (dto.from && !dto.to) {
      throw new BadRequestException('Si proporciona "from", también debe proporcionar "to"');
    }
    if (dto.to && !dto.from) {
      throw new BadRequestException('Si proporciona "to", también debe proporcionar "from"');
    }

    return this.recordingsService.manualRetry(dto);
  }
}
