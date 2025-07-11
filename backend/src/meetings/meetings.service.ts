import { Injectable } from '@nestjs/common';
import { Meeting } from './entities/meeting.entity';
import { ZoomService } from './zoom.service';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { ZoomLicensesService } from '../zoom-licenses/zoom-licenses.service';

@Injectable()
export class MeetingsService {
  private meetings: Meeting[] = [];

  constructor(
    @InjectRepository(Meeting)
    private readonly meetingRepo: Repository<Meeting>,
    private readonly zoomService: ZoomService,
    private readonly zoomLicensesService: ZoomLicensesService,
  ) { }

  async findAll(): Promise<Meeting[]> {
    return this.meetings;
  }

  async findOne(id: string): Promise<Meeting | null> {
    return this.meetings.find((m) => m.id === id) || null;
  }

  async create(data: Partial<Meeting>): Promise<Meeting> {
    if (!data.startTime || !data.userId || !data.topic || !data.courseId) {
      throw new Error('startTime, userId, topic y courseId son requeridos');
    }

    const startTime = new Date(data.startTime);
    const endTime = new Date(startTime.getTime() + 60 * 60 * 1000);

    // Buscar licencia disponible
    const license = await this.zoomLicensesService.getAvailableLicense();

    // Crear reunión en Zoom
    const zoomData = await this.zoomService.createMeeting(
      license.email,
      data.topic,
      startTime.toISOString(),
    );

    const meeting = this.meetingRepo.create({
      ...data,
      zoomMeetingId: zoomData.id,
      licenseId: license.id,
      startTime,
      endTime,
      status: 'scheduled',
    });

    const saved = await this.meetingRepo.save(meeting);

    await this.zoomLicensesService.markAsOccupied(license.id, saved.id);

    return saved;
  }

  async update(id: string, updateData: Partial<Meeting>): Promise<Meeting | { error: string }> {
    const index = this.meetings.findIndex((m) => m.id === id);
    if (index === -1) return { error: 'Not found' };
    this.meetings[index] = { ...this.meetings[index], ...updateData };
    return this.meetings[index];
  }

  async remove(id: string): Promise<Meeting | { error: string }> {
    const index = this.meetings.findIndex((m) => m.id === id);
    if (index === -1) return { error: 'Not found' };
    const removed = this.meetings.splice(index, 1);
    return removed[0];
  }
}
