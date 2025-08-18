import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Meeting } from './entities/meeting.entity';
import { ZoomService } from './zoom.service';
import { ZoomLicensesService } from '../zoom-licenses/zoom-licenses.service';

@Injectable()
export class MeetingsService {
  constructor(
    @InjectRepository(Meeting)
    private readonly meetingRepo: Repository<Meeting>,
    private readonly zoomService: ZoomService,
    private readonly zoomLicensesService: ZoomLicensesService,
  ) {}

  async findAll(): Promise<Meeting[]> {
    return this.meetingRepo.find();
  }

  async findOne(id: string): Promise<Meeting> {
    const meeting = await this.meetingRepo.findOneBy({ id });
    if (!meeting) throw new NotFoundException('Meeting not found');
    return meeting;
  }

  async create(data: Partial<Meeting>): Promise<Meeting> {
    const { topic, courseIdMoodle, startTime: rawStart } = data as any;
    if (!rawStart || !topic || typeof courseIdMoodle !== 'number') {
      throw new Error('startTime, topic y courseIdMoodle son requeridos');
    }

    const startTime = new Date(rawStart as any);

    // 1. Obtener licencia disponible
    const license = await this.zoomLicensesService.getAvailableLicense();

    // 2. Crear reunión en Zoom
    const zoomData = await this.zoomService.createMeeting(
      license.email,
      topic,
      startTime.toISOString(),
    );

    // 3. Preparar la entidad
    const toSave = this.meetingRepo.create({
      topic,
      courseIdMoodle,
      zoomMeetingId: String(zoomData.id),
      zoomLicenseId: license.id,
      startTime,
      status: 'scheduled',
      startUrl: zoomData.start_url,
      joinUrl: zoomData.join_url,
    } as Meeting);

    // 4. Guardar y forzar el tipo Meeting
    const saved = (await this.meetingRepo.save(toSave)) as Meeting;

    // 5. Marcar licencia como ocupada
    await this.zoomLicensesService.markAsOccupied(license.id, saved.id);

    return saved;
  }

  async update(id: string, updateData: Partial<Meeting>): Promise<Meeting> {
    await this.meetingRepo.update(id, updateData);
    return this.findOne(id);
  }

  async remove(id: string): Promise<Meeting> {
    const meeting = await this.findOne(id);
    await this.meetingRepo.remove(meeting);
    await this.zoomLicensesService.releaseLicense(meeting.id);
    return meeting;
  }
}