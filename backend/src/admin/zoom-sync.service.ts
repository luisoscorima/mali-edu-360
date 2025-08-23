import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { ZoomRecordingsService, ZoomMeetingRecording, ZoomRecordingFile } from '../zoom/zoom-recordings.service';
import { MoodleService } from '../moodle/moodle.service';
import { Meeting } from '../meetings/entities/meeting.entity';
import { Recording } from '../recordings/entities/recording.entity';

export interface SyncResult {
  totalZoomRecordings: number;
  newMeetingsCreated: number;
  existingMeetingsFound: number;
  recordingFilesProcessed: number;
  errors: string[];
  summary: {
    meetingId: string;
    zoomMeetingId: string;
    topic: string;
    courseIdMoodle?: number;
    recordingFiles: number;
    status: 'created' | 'exists' | 'error';
    error?: string;
  }[];
}

@Injectable()
export class ZoomSyncService {
  private readonly logger = new Logger(ZoomSyncService.name);

  constructor(
    private readonly zoomRecordingsService: ZoomRecordingsService,
    private readonly moodleService: MoodleService,
    @InjectRepository(Meeting)
    private readonly meetingRepository: Repository<Meeting>,
    @InjectRepository(Recording)
    private readonly recordingRepository: Repository<Recording>,
  ) {}

  async syncZoomRecordings(params: {
    from: string; // YYYY-MM-DD
    to: string;   // YYYY-MM-DD
    dryRun?: boolean;
    maxPages?: number;
    onlyMissingMeetings?: boolean;
  }): Promise<SyncResult> {
    const result: SyncResult = {
      totalZoomRecordings: 0,
      newMeetingsCreated: 0,
      existingMeetingsFound: 0,
      recordingFilesProcessed: 0,
      errors: [],
      summary: [],
    };

    try {
      this.logger.log(`Starting sync from ${params.from} to ${params.to} (dryRun: ${params.dryRun})`);

      // 1. Obtener todas las grabaciones de Zoom
      const zoomRecordings = await this.zoomRecordingsService.getAllRecordings({
        from: params.from,
        to: params.to,
        maxPages: params.maxPages,
      });

      result.totalZoomRecordings = zoomRecordings.length;
      this.logger.log(`Found ${zoomRecordings.length} recordings in Zoom`);

      // 2. Procesar cada grabación
      for (const zoomRecording of zoomRecordings) {
        try {
          const summary = await this.processSingleZoomRecording(zoomRecording, {
            dryRun: params.dryRun,
            onlyMissingMeetings: params.onlyMissingMeetings,
          });

          result.summary.push(summary);

          if (summary.status === 'created') {
            result.newMeetingsCreated++;
          } else if (summary.status === 'exists') {
            result.existingMeetingsFound++;
          }

          result.recordingFilesProcessed += summary.recordingFiles;

        } catch (error) {
          const errorMsg = `Error processing recording ${zoomRecording.id}: ${error.message}`;
          this.logger.error(errorMsg);
          result.errors.push(errorMsg);
          
          result.summary.push({
            meetingId: '',
            zoomMeetingId: zoomRecording.id.toString(),
            topic: zoomRecording.topic,
            recordingFiles: zoomRecording.recording_files?.length || 0,
            status: 'error',
            error: error.message,
          });
        }
      }

      this.logger.log(`Sync completed: ${result.newMeetingsCreated} created, ${result.existingMeetingsFound} existing, ${result.errors.length} errors`);

    } catch (error) {
      const errorMsg = `Sync failed: ${error.message}`;
      this.logger.error(errorMsg);
      result.errors.push(errorMsg);
    }

    return result;
  }

  private async processSingleZoomRecording(
    zoomRecording: ZoomMeetingRecording,
    options: { dryRun?: boolean; onlyMissingMeetings?: boolean }
  ): Promise<SyncResult['summary'][0]> {
    const zoomMeetingId = zoomRecording.id.toString();
    
    // Verificar si ya existe el meeting
    const existingMeeting = await this.meetingRepository.findOne({
      where: { zoomMeetingId },
    });

    if (existingMeeting) {
      if (options.onlyMissingMeetings) {
        return {
          meetingId: existingMeeting.id,
          zoomMeetingId,
          topic: zoomRecording.topic,
          courseIdMoodle: existingMeeting.courseIdMoodle,
          recordingFiles: zoomRecording.recording_files?.length || 0,
          status: 'exists',
        };
      }
    }

    // Resolver curso de Moodle usando el mismo método que el webhook
    let courseIdMoodle: number | null = null;
    try {
      courseIdMoodle = await this.resolveExternalMeetingFromTopic(zoomRecording.topic);
    } catch (error) {
      this.logger.warn(`Could not resolve course for topic "${zoomRecording.topic}": ${error.message}`);
    }

    if (options.dryRun) {
      return {
        meetingId: 'dry-run',
        zoomMeetingId,
        topic: zoomRecording.topic,
        courseIdMoodle: courseIdMoodle || undefined,
        recordingFiles: zoomRecording.recording_files?.length || 0,
        status: existingMeeting ? 'exists' : 'created',
      };
    }

    // Crear o actualizar el meeting
    let meeting: Meeting;
    
    if (existingMeeting) {
      // Actualizar meeting existente si es necesario
      if (!existingMeeting.courseIdMoodle && courseIdMoodle) {
        existingMeeting.courseIdMoodle = courseIdMoodle;
        meeting = await this.meetingRepository.save(existingMeeting);
        this.logger.log(`Updated meeting ${existingMeeting.id} with courseId ${courseIdMoodle}`);
      } else {
        meeting = existingMeeting;
      }
    } else {
      // Crear nuevo meeting
      const meetingData = {
        topic: zoomRecording.topic,
        courseIdMoodle: courseIdMoodle || undefined,
        zoomMeetingId,
        zoomLicenseId: undefined, // Las grabaciones históricas no tienen licencia asignada
        startTime: new Date(zoomRecording.start_time),
        status: 'completed' as const, // Las grabaciones históricas ya están completadas
        joinUrl: undefined,
        startUrl: undefined,
      };

      meeting = this.meetingRepository.create(meetingData);
      meeting = await this.meetingRepository.save(meeting);
      this.logger.log(`Created meeting ${meeting.id} for zoomMeetingId ${zoomMeetingId}`);
    }

    // Crear registros de Recording para cada archivo MP4
    let recordingFilesCount = 0;
    if (zoomRecording.recording_files && zoomRecording.recording_files.length > 0) {
      const mp4Files = zoomRecording.recording_files.filter(
        file => file.file_type === 'MP4' && file.status === 'completed' && file.recording_type === 'shared_screen_with_speaker_view'
      );

      for (const file of mp4Files) {
        const existingRecording = await this.recordingRepository.findOne({
          where: { zoomRecordingId: file.id },
        });

        if (!existingRecording) {
          // Crear placeholder para el recording - sin driveUrl por ahora
          const recordingData = {
            meetingId: meeting.id,
            zoomRecordingId: file.id,
            driveUrl: '', // Se llenará cuando se procese el retry
          };
          
          const recording = this.recordingRepository.create(recordingData);
          await this.recordingRepository.save(recording);
          this.logger.log(`Created recording placeholder ${recording.id} for file ${file.id}`);
          recordingFilesCount++;
        }
      }
    }

    return {
      meetingId: meeting.id,
      zoomMeetingId,
      topic: zoomRecording.topic,
      courseIdMoodle: courseIdMoodle || undefined,
      recordingFiles: recordingFilesCount,
      status: existingMeeting ? 'exists' : 'created',
    };
  }

  // Reutilizar la misma lógica de resolución de curso que RecordingsService
  private async resolveExternalMeetingFromTopic(topic: string): Promise<number | null> {
    try {
      // Buscar curso exacto primero
      let courseIdMoodle = await this.moodleService.findCourseIdByFullnameExact(topic);
      if (courseIdMoodle) {
        return courseIdMoodle;
      }

      // Normalizar y buscar progresivamente
      const normalizedTopics = this.generateTopicVariations(topic);
      
      for (const normalizedTopic of normalizedTopics) {
        courseIdMoodle = await this.moodleService.findCourseIdByFullnameExact(normalizedTopic);
        if (courseIdMoodle) {
          return courseIdMoodle;
        }
      }

      // Usar DEFAULT_COURSE_ID_MOODLE como fallback
      const defaultCourseId = parseInt(process.env.DEFAULT_COURSE_ID_MOODLE || '0');
      return defaultCourseId > 0 ? defaultCourseId : null;

    } catch (error) {
      this.logger.error(`Error resolving course for topic "${topic}":`, error);
      return null;
    }
  }

  private generateTopicVariations(topic: string): string[] {
    const variations: string[] = [];
    let current = topic;

    // 1. Remover contenido entre paréntesis
    current = current.replace(/\s*\([^)]*\)\s*/g, ' ').trim();
    if (current !== topic) variations.push(current);

    // 2. Cortar en separadores comunes
    const separators = [' - ', ' – ', ' | ', ' : ', ' :: '];
    for (const sep of separators) {
      if (current.includes(sep)) {
        const parts = current.split(sep);
        variations.push(parts[0].trim());
        if (parts.length > 1) variations.push(parts[1].trim());
      }
    }

    // 3. Eliminar sufijos comunes
    const suffixes = [' Clase', ' Meeting', ' Session', ' Call', ' Conference'];
    for (const suffix of suffixes) {
      if (current.endsWith(suffix)) {
        variations.push(current.slice(0, -suffix.length).trim());
      }
    }

    // 4. Truncar por palabras (máximo 3 palabras)
    const words = current.split(/\s+/);
    if (words.length > 3) {
      variations.push(words.slice(0, 3).join(' '));
    }
    if (words.length > 2) {
      variations.push(words.slice(0, 2).join(' '));
    }

    return Array.from(new Set(variations.filter(v => v.length > 0)));
  }

  async getRecordingsToRetry(params: {
    from?: string;
    to?: string;
    onlyWithoutDriveUrl?: boolean;
    limit?: number;
  }): Promise<{ meeting: Meeting; recordings: Recording[] }[]> {
    const queryBuilder = this.recordingRepository
      .createQueryBuilder('recording')
      .leftJoinAndSelect('recording.meeting', 'meeting')
      .where('meeting.id IS NOT NULL');

    if (params.onlyWithoutDriveUrl) {
      queryBuilder.andWhere('(recording.driveUrl = \'\' OR recording.driveUrl IS NULL)');
    }

    if (params.from) {
      queryBuilder.andWhere('recording.createdAt >= :from', { from: new Date(params.from) });
    }

    if (params.to) {
      queryBuilder.andWhere('recording.createdAt <= :to', { to: new Date(params.to) });
    }

    queryBuilder
      .orderBy('recording.createdAt', 'DESC')
      .limit(params.limit || 50);

    const recordings = await queryBuilder.getMany();

    // Agrupar por meeting
    const grouped = new Map<string, { meeting: Meeting; recordings: Recording[] }>();
    
    for (const recording of recordings) {
      const meetingId = (recording as any).meeting.id;
      if (!grouped.has(meetingId)) {
        grouped.set(meetingId, {
          meeting: (recording as any).meeting,
          recordings: [],
        });
      }
      grouped.get(meetingId)!.recordings.push(recording);
    }

    return Array.from(grouped.values());
  }

  async findRecordingByZoomMeetingId(zoomMeetingId: string): Promise<Recording | null> {
    const recording = await this.recordingRepository
      .createQueryBuilder('recording')
      .leftJoinAndSelect('recording.meeting', 'meeting')
      .where('meeting.zoomMeetingId = :zoomMeetingId', { zoomMeetingId })
      .getOne();

    return recording;
  }
}
