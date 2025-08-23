import { Controller, Get, Query } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Meeting } from '../meetings/entities/meeting.entity';
import { Recording } from '../recordings/entities/recording.entity';

@Controller('admin/debug')
export class AdminDebugController {
  constructor(
    @InjectRepository(Meeting)
    private readonly meetingRepository: Repository<Meeting>,
    @InjectRepository(Recording)
    private readonly recordingRepository: Repository<Recording>,
  ) {}

  @Get('meetings')
  async getMeetings(@Query('limit') limit = 10) {
    return this.meetingRepository.find({
      take: parseInt(limit.toString()),
      order: { startTime: 'DESC' },
    });
  }

  @Get('recordings')
  async getRecordings(@Query('limit') limit = 10) {
    return this.recordingRepository.find({
      take: parseInt(limit.toString()),
      order: { createdAt: 'DESC' },
    });
  }

  @Get('meetings/search')
  async searchMeetings(@Query('zoomMeetingId') zoomMeetingId: string) {
    if (!zoomMeetingId) {
      return { error: 'zoomMeetingId query parameter required' };
    }
    
    const meetings = await this.meetingRepository.find({
      where: { zoomMeetingId },
    });
    
    return {
      zoomMeetingId,
      found: meetings.length,
      meetings,
    };
  }

  @Get('recordings/search')
  async searchRecordings(@Query('zoomMeetingId') zoomMeetingId: string) {
    if (!zoomMeetingId) {
      return { error: 'zoomMeetingId query parameter required' };
    }
    
    const recordings = await this.recordingRepository
      .createQueryBuilder('recording')
      .leftJoinAndSelect('recording.meeting', 'meeting')
      .where('meeting.zoomMeetingId = :zoomMeetingId', { zoomMeetingId })
      .getMany();
    
    return {
      zoomMeetingId,
      found: recordings.length,
      recordings,
    };
  }

  @Get('stats')
  async getStats() {
    const totalMeetings = await this.meetingRepository.count();
    const totalRecordings = await this.recordingRepository.count();
    const completedMeetings = await this.meetingRepository.count({
      where: { status: 'completed' },
    });
    const scheduledMeetings = await this.meetingRepository.count({
      where: { status: 'scheduled' },
    });

    return {
      totalMeetings,
      totalRecordings,
      completedMeetings,
      scheduledMeetings,
    };
  }
}
