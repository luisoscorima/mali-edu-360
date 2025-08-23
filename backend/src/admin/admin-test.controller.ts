import { Controller, Post, Body } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Meeting } from '../meetings/entities/meeting.entity';
import { Recording } from '../recordings/entities/recording.entity';

@Controller('admin/test')
export class AdminTestController {
  constructor(
    @InjectRepository(Meeting)
    private readonly meetingRepository: Repository<Meeting>,
    @InjectRepository(Recording)
    private readonly recordingRepository: Repository<Recording>,
  ) {}

  @Post('create-test-meeting')
  async createTestMeeting(@Body() body: { zoomMeetingId: string; topic?: string; courseIdMoodle?: number }) {
    const { zoomMeetingId, topic = 'Test Meeting', courseIdMoodle = 13 } = body;

    // Verificar si ya existe
    const existing = await this.meetingRepository.findOne({
      where: { zoomMeetingId },
    });

    if (existing) {
      return { message: 'Meeting already exists', meetingId: existing.id };
    }

    // Crear meeting de prueba
    const meeting = this.meetingRepository.create({
      topic,
      courseIdMoodle,
      zoomMeetingId,
      startTime: new Date(),
      status: 'completed',
    });

    const savedMeeting = await this.meetingRepository.save(meeting);

    // Crear recording placeholder
    const recording = this.recordingRepository.create({
      meetingId: savedMeeting.id,
      zoomRecordingId: `test-${zoomMeetingId}`,
      driveUrl: '', // Vacío para simular que necesita procesamiento
    });

    await this.recordingRepository.save(recording);

    return {
      message: 'Test meeting and recording created',
      meetingId: savedMeeting.id,
      recordingId: recording.id,
    };
  }
}
