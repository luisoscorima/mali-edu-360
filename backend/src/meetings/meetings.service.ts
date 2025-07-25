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
    const { topic, userId, courseId, startTime: rawStart } = data;
    if (!rawStart || !userId || !topic || !courseId) {
      throw new Error('startTime, userId, topic y courseId son requeridos');
    }

    const startTime = new Date(rawStart);
    const endTime = new Date(startTime.getTime() + 60 * 60 * 1000);

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
      userId,
      courseId,
      zoomMeetingId: String(zoomData.id),
      licenseId: license.id,
      startTime,
      endTime,
      status: 'scheduled',
      // Si añadiste estas columnas en tu entidad:
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
    await this.zoomLicensesService.releaseLicense(meeting.licenseId);
    return meeting;
  }
}