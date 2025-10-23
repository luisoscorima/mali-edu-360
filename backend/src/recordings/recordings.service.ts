import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios, { AxiosResponse } from 'axios';
import * as path from 'path';
import * as fs from 'fs';
import * as https from 'https';
import * as http from 'http';
import { createHash } from 'crypto';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, DeepPartial } from 'typeorm';
import { DriveService } from '../drive/drive.service';
import { MoodleService } from '../moodle/moodle.service';
import { Recording } from './entities/recording.entity';
import { ZoomLicensesService } from '../zoom-licenses/zoom-licenses.service';
import { Meeting } from '../meetings/entities/meeting.entity';
import { ZoomService } from '../meetings/zoom.service';

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

export interface RetryRequestDTO {
  zoomRecordingId?: string;
  meetingId?: string;
  zoomMeetingId?: string;
  from?: string;
  to?: string;
  republish?: boolean;
  forceRedownload?: boolean;
  forceRepost?: boolean;
  overrideCourseIdMoodle?: number;
  dryRun?: boolean;
  limit?: number;
}

@Injectable()
export class RecordingsService {
  private readonly logger = new Logger(RecordingsService.name);
  // Simple in-memory lock to avoid concurrent processing for the same meeting
  private readonly inFlightMeetings = new Set<string>();
  // Manual retry concurrency guard
  private readonly retryGuard = new Map<string, Promise<any>>();

  // Config defaults (overridable via env)
  private readonly MAX_RETRIES_DOWNLOAD = this.getIntEnv('MAX_RETRIES_DOWNLOAD', 10);
  private readonly MAX_RETRIES_UPLOAD = this.getIntEnv('MAX_RETRIES_UPLOAD', 10);
  private readonly INITIAL_BACKOFF_MS = this.getIntEnv('INITIAL_BACKOFF_MS', 30000);
  private readonly MAX_BACKOFF_MS = this.getIntEnv('MAX_BACKOFF_MS', 300000);
  private readonly DOWNLOAD_TIMEOUT_MS = this.getIntEnv('DOWNLOAD_TIMEOUT_MS', 0); // 0 = no limit
  private readonly DRIVE_UPLOAD_TIMEOUT_MS = this.getIntEnv('DRIVE_UPLOAD_TIMEOUT_MS', 0);
  private readonly MIN_EXPECTED_SIZE_MB = this.getIntEnv('MIN_EXPECTED_SIZE_MB', 1);

  constructor(
    @InjectRepository(Recording)
    private readonly recRepo: Repository<Recording>,
    @InjectRepository(Meeting)
    private readonly meetingRepo: Repository<Meeting>,
    private readonly driveService: DriveService,
    private readonly moodleService: MoodleService,
    private readonly zoomLicenses: ZoomLicensesService,
    private readonly zoomService: ZoomService,
    private readonly configService: ConfigService,
  ) { }

  /**
   * Handles Zoom event payload for recording.completed
   */
  async processRecordingCompleted(payload: any) {
    const object = payload?.payload?.object;
    const topic: string | undefined = object?.topic;
    const zoomMeetingId: string | undefined = String(object?.id || object?.uuid || '');
    const files: any[] = object?.recording_files || [];
    const downloadToken: string | undefined = payload?.download_token;

    this.logger.log(`recording.completed received - zoomMeetingId=${zoomMeetingId}, topic=${topic}, files=${files.length}`);

    if (!zoomMeetingId || files.length === 0) {
      this.logger.warn('Webhook sin meetingId o archivos');
      return { status: 'ignored' };
    }

    // Prevent concurrent processing for the same meeting (Zoom can send duplicates)
    if (zoomMeetingId && this.inFlightMeetings.has(zoomMeetingId)) {
      this.logger.warn(`Otro proceso ya está manejando meetingId=${zoomMeetingId}. Se ignora este evento (in-flight).`);
      return { status: 'in-flight' };
    }
    if (zoomMeetingId) this.inFlightMeetings.add(zoomMeetingId);

    // Map Zoom meeting to our Meeting entity; if missing (e.g., created via Moodle LTI), try to infer by topic and create it
    let meeting: Meeting | null = await this.meetingRepo.findOne({ where: { zoomMeetingId } });
    if (!meeting) {
      this.logger.warn(`No se encontró Meeting para zoomMeetingId=${zoomMeetingId}. Intentando mapear por topic a curso Moodle (LTI)…`);
      try {
        const inferred = await this.resolveExternalMeetingFromTopic(zoomMeetingId, topic);
        if (!inferred) {
          this.logger.warn(`No se pudo inferir curso desde topic="${topic}". Evento ignorado.`);
          if (zoomMeetingId) this.inFlightMeetings.delete(zoomMeetingId);
          return { status: 'ignored' };
        }
        meeting = inferred;
        this.logger.log(`Meeting creado por LTI: id=${meeting!.id}, courseIdMoodle=${meeting!.courseIdMoodle}`);
      } catch (e: any) {
        this.logger.warn(`Fallo al crear Meeting desde topic: ${e?.message || e}`);
        if (zoomMeetingId) this.inFlightMeetings.delete(zoomMeetingId);
        return { status: 'ignored' };
      }
    } else {
      this.logger.log(`Meeting encontrado: id=${meeting.id}, courseIdMoodle=${meeting.courseIdMoodle}`);
    }

    // Seleccionar el archivo MP4 preferentemente con estado "completed"; fallback a cualquier MP4 con URL
    const mp4 =
      files.find((f: any) => f.file_type === 'MP4' && f.download_url && (f.status === 'completed' || f.recording_status === 'completed')) ||
      files.find((f: any) => f.file_type === 'MP4' && f.download_url);
    if (!mp4) {
      this.logger.warn('No hay archivo MP4 en la grabación');
      return { status: 'ignored' };
    }

    const zoomRecordingId: string = String(mp4.id || mp4.file_id || mp4.recording_start || 'unknown');
    const expectedBytes: number | undefined = typeof mp4.file_size === 'number' ? mp4.file_size : undefined;

    try {
      // Idempotency: if already processed locally or in Drive, exit gracefully
      const existing = await this.recRepo.findOne({ where: { zoomRecordingId } });
      if (existing) {
        this.logger.log(`Idempotente: recording ya procesada (DB) zoomRecordingId=${zoomRecordingId}.`);
        await this.meetingRepo.update(meeting!.id, { status: 'completed' as any });
        await this.zoomLicenses.releaseLicense(meeting!.id);
        return { status: 'done', driveUrl: existing.driveUrl };
      }
      const existingDrive = await this.driveService.findFileByZoomRecordingId(zoomRecordingId);
      if (existingDrive) {
        this.logger.log(`Idempotente: archivo ya en Drive por zoomRecordingId=${zoomRecordingId}. Creando registro en DB y cerrando flujo.`);
        const rec = this.recRepo.create({ meetingId: meeting!.id, zoomRecordingId, driveUrl: existingDrive.webViewLink });
        await this.recRepo.save(rec);
        await this.meetingRepo.update(meeting!.id, { status: 'completed' as any });
        await this.zoomLicenses.releaseLicense(meeting!.id);
        return { status: 'done', driveUrl: existingDrive.webViewLink };
      }

      // 1) Download with retries (long-running, resumable)
      const filename = `${(topic || 'Clase').replace(/[^a-zA-Z0-9-_]/g, '_')}_${new Date().toISOString().slice(0, 10)}.mp4`;
      const localPath = path.join(process.cwd(), 'downloads', filename);
      await this.ensureDownloadDir();
      this.logger.log(`Descargando grabación desde Zoom a: ${localPath}`);

      const dlStartedAt = Date.now();
      await this.withRobustRetries('download', async (attempt) => {
        // Intento 1: usar download_token del webhook (si existe). Siguientes intentos: forzar OAuth (token interno) para evitar token rancio/expirado.
        const tokenForThisAttempt = attempt === 1 ? downloadToken : undefined;

        // HEAD fresco en cada intento para detectar readiness y refrescar autorización.
        const headInfo = await this.warmupHead(mp4.download_url, tokenForThisAttempt);
        const minBytes = this.MIN_EXPECTED_SIZE_MB * 1024 * 1024;
        if (headInfo?.contentLength && headInfo.contentLength < minBytes) {
          // Aún no listo o placeholder de Zoom. Provocar reintento con backoff.
          throw new Error(`Recording not ready (HEAD content-length=${headInfo.contentLength})`);
        }
        if (headInfo && headInfo.contentLength && expectedBytes && Math.abs(headInfo.contentLength - expectedBytes) / expectedBytes > 0.01) {
          this.logger.warn(`HEAD size difiere de payload: head=${headInfo.contentLength} payload=${expectedBytes}`);
        }

        const info = await this.downloadZoomRecording(mp4.download_url, localPath, tokenForThisAttempt);
        // Validaciones previas a la subida
        const ok = await this.validateDownloadedFile(localPath, expectedBytes, info.contentType);
        if (!ok) {
          // Eliminar archivo parcial para que el siguiente intento no use Range inválido
          try { fs.unlinkSync(localPath); } catch { }
          throw new Error('Archivo descargado inválido o incompleto');
        }
      });
      const dlMs = Date.now() - dlStartedAt;
      const { size: finalDownloadSize } = fs.statSync(localPath);
      this.logger.log(`Descarga completa (${finalDownloadSize} bytes) en ${Math.round(dlMs / 1000)}s.`);

      // 2) Upload to Drive into course folder + yyyy-mm
      const courseFolderCode = String(meeting!.courseIdMoodle);
      const rootDrive = process.env.GDRIVE_SHARED_DRIVE_ID ?? '';
      const courseFolderId = await this.driveService.ensureFolder(courseFolderCode, rootDrive);
      this.logger.log(`Carpeta curso en Drive: ${courseFolderCode} -> ${courseFolderId}`);
      const monthFolderId = await this.driveService.ensureFolder(new Date().toISOString().slice(0, 7), courseFolderId);
      const upStartedAt = Date.now();
      const upload = await this.withRobustRetries('upload', async (attempt) => {
        const res = await this.driveService.uploadFile(localPath, filename, monthFolderId, {
          meetingId: meeting!.id,
          courseIdMoodle: meeting!.courseIdMoodle!,
          zoomRecordingId,
          timeoutMs: this.DRIVE_UPLOAD_TIMEOUT_MS,
        });
        // Verify MD5
        const localMd5 = await this.md5File(localPath);
        if (res.md5Checksum && res.md5Checksum !== localMd5) {
          this.logger.warn(`MD5 mismatch: drive=${res.md5Checksum} local=${localMd5}`);
          throw new Error('MD5 checksum mismatch after upload');
        }
        return { ...res, localMd5 };
      });
      const driveLink = upload.webViewLink;
      const upMs = Date.now() - upStartedAt;
      this.logger.log(`Archivo subido a Drive: ${driveLink} | md5=${upload.md5Checksum || upload.localMd5} | ${Math.round(upMs / 1000)}s`);

      const forumId = await this.moodleService.getRecordedForumId(meeting!.courseIdMoodle!);
      this.logger.log(`Publicando en foro Moodle ${forumId} del curso ${meeting!.courseIdMoodle}`);
      const previewLink = driveLink.replace('/view', '/preview');
      const iframe = `<div style="max-width: 720px; width: 80vw; margin: 20px auto;"><div style="position: relative; width: 100%; padding-top: 56.25%;"><iframe style="position: absolute; inset: 0; width: 100%; height: 100%; border: 0;" src="${previewLink}" allow="autoplay; encrypted-media" allowfullscreen="allowfullscreen"></iframe><div style="position: absolute; top: 8px; right: 8px; width: 72px; height: 72px; z-index: 3; background: transparent; cursor: not-allowed;" title="Pop-out deshabilitado" aria-label="Pop-out deshabilitado"></div></div></div>`;
      const downloadDate = new Date().toISOString().slice(0, 10);
      const subject = `${topic || 'Clase grabada'} | ${downloadDate} [${zoomRecordingId}]`;
      await this.withRobustRetries('upload', async () => {
        await this.moodleService.addForumDiscussion(forumId, subject, iframe);
      });

      // 4) Persist Recording
      const rec = this.recRepo.create({
        meetingId: meeting!.id,
        zoomRecordingId,
        driveUrl: driveLink,
      });
      await this.recRepo.save(rec);

      // 5) Update meeting and release license
      await this.meetingRepo.update(meeting!.id, { status: 'completed' as any });
      await this.zoomLicenses.releaseLicense(meeting!.id);

      // 6) Cleanup local file
      try { fs.unlinkSync(localPath); } catch { }

      this.logger.log(`Pipeline OK | tiempo total: descarga ${Math.round(dlMs / 1000)}s + subida ${Math.round(upMs / 1000)}s`);
      this.logger.log(`Grabación procesada y publicada: ${previewLink}`);
      return { status: 'done', driveUrl: driveLink };
    } finally {
      if (zoomMeetingId) this.inFlightMeetings.delete(zoomMeetingId);
    }
  }

  /**
   * For Zoom meetings created via Moodle LTI (not present in DB), infer the Moodle course from the Zoom topic
   * by trying fullname and shortname, and create a minimal Meeting entry to attach the recording.
   */
  private async resolveExternalMeetingFromTopic(
    zoomMeetingId: string,
    topic?: string,
  ): Promise<Meeting | null> {
    if (!topic) return null;
    let courseId: number | null = null;

    const tryResolve = async (candidate: string): Promise<number | null> => {
      // 0) exact fullname/displayname via search
      try {
        const exact = await this.moodleService.findCourseIdByFullnameExact(candidate);
        if (exact) return exact;
      } catch { }
      // 1) fullname
      try {
        const id = await this.moodleService.findCourseIdByField('fullname', candidate);
        return id;
      } catch { }
      // 2) shortname
      try {
        const id = await this.moodleService.findCourseIdByField('shortname', candidate);
        return id;
      } catch { }
      // 3) search (first result)
      try {
        const id = await this.moodleService.searchCourseIdByName(candidate);
        if (id) return id;
      } catch { }
      return null;
    };

    // Primary attempts with original topic
    courseId = await tryResolve(topic);

    // Build normalized candidates if needed
    if (!courseId) {
      const candidates: string[] = [];
      const trimmed = topic.trim();
      const noParens = trimmed.replace(/\s*[\(\[].*?[\)\]]\s*$/g, '').trim();
      if (noParens && noParens !== trimmed) candidates.push(noParens);
      const splitDash = trimmed.split(/\s*[-–—:\|]\s*/)[0]?.trim();
      if (splitDash && splitDash.length >= 3 && splitDash !== trimmed) candidates.push(splitDash);
      const rmSuffixUpper2 = trimmed.replace(/\s+[A-Z]{1,3}$/, '').trim(); // e.g., "EP"
      if (rmSuffixUpper2 && rmSuffixUpper2.length >= 3 && rmSuffixUpper2 !== trimmed) candidates.push(rmSuffixUpper2);

      for (const cand of candidates) {
        this.logger.log(`Intentando resolver curso por variante: "${cand}"`);
        courseId = await tryResolve(cand);
        if (courseId) break;
      }
    }

    // Progressive truncation (remove last word) up to 3 attempts
    if (!courseId) {
      const words = topic.split(/\s+/).filter(Boolean);
      for (let cut = 1; cut <= 3 && words.length - cut >= 2; cut++) {
        const cand = words.slice(0, words.length - cut).join(' ');
        this.logger.log(`Intentando resolver curso por truncación: "${cand}"`);
        courseId = await tryResolve(cand);
        if (courseId) break;
      }
    }

    if (!courseId) {
      const defCourse = Number(process.env.DEFAULT_COURSE_ID_MOODLE);
      if (Number.isFinite(defCourse) && defCourse > 0) {
        this.logger.warn(`Curso no encontrado para topic="${topic}". Usando DEFAULT_COURSE_ID_MOODLE=${defCourse}.`);
        courseId = defCourse;
      } else {
        this.logger.warn(`Curso no encontrado por topic="${topic}" tras variantes y truncaciones, y sin DEFAULT_COURSE_ID_MOODLE`);
        return null;
      }
    }

    const entity = this.meetingRepo.create({
      topic: topic,
      courseIdMoodle: courseId!,
      zoomMeetingId: String(zoomMeetingId),
      zoomLicenseId: null as any,
      startTime: new Date(),
      status: 'scheduled',
    } as DeepPartial<Meeting>);
    const saved = (await this.meetingRepo.save(entity)) as Meeting;
    return saved;
  }

  /**
   * Manual retry system for failed or missed recordings
   */
  async manualRetry(dto: RetryRequestDTO): Promise<RetryResult[]> {
    this.logger.log(`retry:start - selector=${JSON.stringify(this.extractSelector(dto))}`);

    const limit = dto.limit ?? 5;
    const results: RetryResult[] = [];

    try {
      // Resolve target recordings
      const targets = await this.resolveRetryTargets(dto, limit);
      this.logger.log(`retry:resolve - found ${targets.length} target(s)`);

      // Process each target
      for (const target of targets) {
        const guardKey = target.zoomRecordingId || target.meetingId || 'unknown';

        // Check if already being processed
        if (this.retryGuard.has(guardKey)) {
          results.push({
            selector: this.extractSelector(dto),
            mode: 'skipped',
            status: 'skipped',
            reason: 'already-in-progress',
            ...target,
          });
          continue;
        }

        // Process with guard
        const promise = this.processRetryTarget(target, dto);
        this.retryGuard.set(guardKey, promise);

        try {
          const result = await promise;
          results.push(result);
        } finally {
          this.retryGuard.delete(guardKey);
        }
      }

      return results;
    } catch (error) {
      this.logger.error(`retry:fail - ${error.message}`, error.stack);
      throw error;
    }
  }

  private extractSelector(dto: RetryRequestDTO): Record<string, any> {
    if (dto.zoomRecordingId) return { zoomRecordingId: dto.zoomRecordingId };
    if (dto.meetingId) return { meetingId: dto.meetingId };
    if (dto.zoomMeetingId) return { zoomMeetingId: dto.zoomMeetingId };
    if (dto.from && dto.to) return { from: dto.from, to: dto.to };
    return {};
  }

  private async resolveRetryTargets(dto: RetryRequestDTO, limit: number): Promise<Array<{
    zoomRecordingId?: string;
    meetingId?: string;
    zoomMeetingId?: string;
    courseIdMoodle?: number;
    topic?: string;
    recording?: Recording;
    meeting?: Meeting;
  }>> {
    const targets: any[] = [];

    if (dto.zoomRecordingId) {
      // Single recording by zoomRecordingId
      const recording = await this.recRepo.findOne({
        where: { zoomRecordingId: dto.zoomRecordingId },
        relations: ['meeting'], // if you have relations set up
      });

      let meeting: Meeting | undefined;
      if (recording?.meetingId) {
        meeting = await this.meetingRepo.findOne({ where: { id: recording.meetingId } }) || undefined;
      }

      targets.push({
        zoomRecordingId: dto.zoomRecordingId,
        recording,
        meeting,
        meetingId: meeting?.id,
        zoomMeetingId: meeting?.zoomMeetingId,
        courseIdMoodle: meeting?.courseIdMoodle,
        topic: meeting?.topic,
      });
    }

    if (dto.meetingId) {
      // Single meeting by internal meetingId
      const meeting = await this.meetingRepo.findOne({ where: { id: dto.meetingId } });
      if (meeting) {
        const recordings = await this.recRepo.find({ where: { meetingId: dto.meetingId } });
        if (recordings.length > 0) {
          for (const recording of recordings) {
            targets.push({
              zoomRecordingId: recording.zoomRecordingId,
              recording,
              meeting,
              meetingId: meeting.id,
              zoomMeetingId: meeting.zoomMeetingId,
              courseIdMoodle: meeting.courseIdMoodle,
              topic: meeting.topic,
            });
          }
        } else {
          // No recordings yet, might need to fetch from Zoom
          targets.push({
            meeting,
            meetingId: meeting.id,
            zoomMeetingId: meeting.zoomMeetingId,
            courseIdMoodle: meeting.courseIdMoodle,
            topic: meeting.topic,
          });
        }
      }
    }

    if (dto.zoomMeetingId) {
      // Single meeting by zoomMeetingId
      const meeting = await this.meetingRepo.findOne({ where: { zoomMeetingId: dto.zoomMeetingId } });
      if (meeting) {
        const recordings = await this.recRepo.find({ where: { meetingId: meeting.id } });
        if (recordings.length > 0) {
          for (const recording of recordings) {
            targets.push({
              zoomRecordingId: recording.zoomRecordingId,
              recording,
              meeting,
              meetingId: meeting.id,
              zoomMeetingId: meeting.zoomMeetingId,
              courseIdMoodle: meeting.courseIdMoodle,
              topic: meeting.topic,
            });
          }
        } else {
          targets.push({
            meeting,
            meetingId: meeting.id,
            zoomMeetingId: meeting.zoomMeetingId,
            courseIdMoodle: meeting.courseIdMoodle,
            topic: meeting.topic,
          });
        }
      } else {
        // Meeting not in DB: query Zoom for metadata (topic) to enable auto-resolution
        try {
          const { ZoomRecordingsService } = await import('../zoom/zoom-recordings.service');
          const zoomRecordingsService = new ZoomRecordingsService(this.configService);
          const zoomRec = await zoomRecordingsService.getRecordingById(dto.zoomMeetingId);
          if (zoomRec) {
            targets.push({
              zoomMeetingId: dto.zoomMeetingId,
              topic: zoomRec.topic,
            });
          }
        } catch { }
      }
    }

    if (dto.from && dto.to) {
      // Time range query
      const fromDate = new Date(dto.from);
      const toDate = new Date(dto.to);

      // Get recordings in time range
      const recordings = await this.recRepo.createQueryBuilder('r')
        .leftJoinAndSelect('r.meeting', 'm')
        .where('r.createdAt >= :from AND r.createdAt <= :to', { from: fromDate, to: toDate })
        .limit(limit)
        .getMany();

      for (const recording of recordings) {
        const meeting = await this.meetingRepo.findOne({ where: { id: recording.meetingId } });
        targets.push({
          zoomRecordingId: recording.zoomRecordingId,
          recording,
          meeting,
          meetingId: meeting?.id,
          zoomMeetingId: meeting?.zoomMeetingId,
          courseIdMoodle: meeting?.courseIdMoodle,
          topic: meeting?.topic,
        });
      }
    }

    return targets.slice(0, limit);
  }

  private async processRetryTarget(target: any, dto: RetryRequestDTO): Promise<RetryResult> {
    const selector = this.extractSelector(dto);

    try {
      // If meeting does not exist yet but we have Zoom metadata, create it by resolving course from topic
      if (!target.meeting && target.zoomMeetingId && target.topic) {
        try {
          const created = await this.resolveExternalMeetingFromTopic(String(target.zoomMeetingId), target.topic);
          if (created) {
            target.meeting = created;
            target.meetingId = created.id;
            target.courseIdMoodle = created.courseIdMoodle;
          }
        } catch { }
      }
      if (dto.dryRun) {
        return {
          selector,
          mode: 'skipped',
          status: 'skipped',
          reason: 'dry-run',
          ...this.extractTargetMetadata(target),
        };
      }

      // Determine course
      let courseIdMoodle = dto.overrideCourseIdMoodle || target.courseIdMoodle;
      if (!courseIdMoodle && target.topic) {
        // Resolve using the real zoomMeetingId and topic; also creates Meeting if missing
        const resolved = await this.resolveExternalMeetingFromTopic(String(target.zoomMeetingId || 'manual-retry'), target.topic);
        courseIdMoodle = resolved?.courseIdMoodle;
        if (resolved) {
          target.meeting = resolved;
          target.meetingId = resolved.id;
        }
      }

      if (!courseIdMoodle) {
        return {
          selector,
          mode: 'skipped',
          status: 'failed',
          reason: 'no-course-resolved',
          ...this.extractTargetMetadata(target),
        };
      }

      // Check if already completed and not forced (only if driveUrl exists)
      if (target.recording && target.recording.driveUrl && !dto.forceRedownload && !dto.forceRepost) {
        // Already completed, might just need republish
        if (dto.republish) {
          return await this.executeRepublishMode(target, courseIdMoodle, dto, selector);
        } else {
          return {
            selector,
            mode: 'skipped',
            status: 'skipped',
            reason: 'already-completed',
            ...this.extractTargetMetadata(target),
          };
        }
      }

      // Determine mode
      const mode = this.determineRetryMode(target, dto);
      this.logger.log(`retry:mode=${mode} - zoomRecordingId=${target.zoomRecordingId}`);

      if (mode === 'republish') {
        return await this.executeRepublishMode(target, courseIdMoodle, dto, selector);
      } else {
        return await this.executeFullMode(target, courseIdMoodle, dto, selector);
      }

    } catch (error) {
      this.logger.error(`retry:fail - target=${JSON.stringify(selector)} error=${error.message}`);
      return {
        selector,
        mode: 'skipped',
        status: 'failed',
        reason: error.message,
        ...this.extractTargetMetadata(target),
      };
    }
  }

  private extractTargetMetadata(target: any) {
    return {
      meetingId: target.meetingId,
      zoomMeetingId: target.zoomMeetingId,
      driveUrl: target.recording?.driveUrl,
    };
  }

  private determineRetryMode(target: any, dto: RetryRequestDTO): 'republish' | 'full' {
    if (dto.forceRedownload) return 'full';
    if (dto.republish && target.recording?.driveUrl) return 'republish';
    return 'full';
  }

  private async executeRepublishMode(target: any, courseIdMoodle: number, dto: RetryRequestDTO, selector: any): Promise<RetryResult> {
    try {
      // Verify Drive file exists and is valid
      if (!target.recording?.driveUrl) {
        return {
          selector,
          mode: 'republish',
          status: 'failed',
          reason: 'no-drive-url-found',
          courseIdMoodle,
          ...this.extractTargetMetadata(target),
        };
      }

      // Get forum and create post
      const forumId = await this.moodleService.getRecordedForumId(courseIdMoodle);
      const topic = target.topic || 'Clase grabada';
      const zoomRecordingId = target.zoomRecordingId || 'unknown';

      const previewLink = target.recording.driveUrl.replace('/view', '/preview');
      const iframe = `<div style="max-width: 720px; width: 80vw; margin: 20px auto;"><div style="position: relative; width: 100%; padding-top: 56.25%;"><iframe style="position: absolute; inset: 0; width: 100%; height: 100%; border: 0;" src="${previewLink}" allow="autoplay; encrypted-media" allowfullscreen="allowfullscreen"></iframe><div style="position: absolute; top: 8px; right: 8px; width: 72px; height: 72px; z-index: 3; background: transparent; cursor: not-allowed;" title="Pop-out deshabilitado" aria-label="Pop-out deshabilitado"></div></div></div>`;
      const republishDate = new Date().toISOString().slice(0, 10);
      const subject = `${topic} | ${republishDate} [${zoomRecordingId}]`;

      await this.moodleService.addForumDiscussion(forumId, subject, iframe);

      // Update retry tracking
      if (target.recording) {
        await this.recRepo.update(target.recording.id, {
          retryCount: (target.recording.retryCount || 0) + 1,
          lastRetryAt: new Date(),
        });
      }

      this.logger.log(`retry:done - mode=republish zoomRecordingId=${zoomRecordingId}`);

      return {
        selector,
        mode: 'republish',
        status: 'ok',
        reason: 'republished-successfully',
        courseIdMoodle,
        ...this.extractTargetMetadata(target),
      };

    } catch (error) {
      return {
        selector,
        mode: 'republish',
        status: 'failed',
        reason: error.message,
        courseIdMoodle,
        ...this.extractTargetMetadata(target),
      };
    }
  }

  private async executeFullMode(target: any, courseIdMoodle: number, dto: RetryRequestDTO, selector: any): Promise<RetryResult> {
    try {
      // Obtener información de la grabación desde Zoom
      const { ZoomRecordingsService } = await import('../zoom/zoom-recordings.service');
      const zoomRecordingsService = new ZoomRecordingsService(this.configService);

      const meeting = target.meeting || target;
      const zoomMeetingId = meeting.zoomMeetingId;

      if (!zoomMeetingId) {
        throw new Error('No zoomMeetingId found for full mode processing');
      }

      const zoomRecording = await zoomRecordingsService.getRecordingById(zoomMeetingId);
      if (!zoomRecording) {
        throw new Error('Recording not found in Zoom');
      }

      // Selección robusta de MP4: preferir tipos de mayor calidad, luego por tamaño
      const mp4Candidates = (zoomRecording.recording_files || []).filter((f: any) => f.file_type === 'MP4' && f.status === 'completed');
      const preferOrder = ['shared_screen_with_speaker_view', 'active_speaker', 'speaker_view', 'gallery_view'];
      const mp4File = [...mp4Candidates].sort((a: any, b: any) => {
        const ia = preferOrder.indexOf(a.recording_type);
        const ib = preferOrder.indexOf(b.recording_type);
        const wa = ia === -1 ? preferOrder.length : ia;
        const wb = ib === -1 ? preferOrder.length : ib;
        if (wa !== wb) return wa - wb;
        return (b.file_size || 0) - (a.file_size || 0);
      })[0];

      if (!mp4File) {
        throw new Error('MP4 file not found in Zoom recording');
      }

      const filename = `${zoomMeetingId}_${mp4File.id}.mp4`;
      const downloadPath = path.join(process.cwd(), 'downloads', filename);

      try {
        // Descargar desde Zoom usando la URL de descarga (S2S OAuth)
        await this.downloadZoomRecording(mp4File.download_url, downloadPath);
        // Validar archivo descargado (tamaño y tipo)
        const valid = await this.validateDownloadedFile(downloadPath, mp4File.file_size);
        if (!valid) {
          throw new Error('Downloaded file failed validation (size/type)');
        }

        // Resolver carpetas en Drive: curso y YYYY-MM
        const courseFolderCode = String(courseIdMoodle);
        const courseFolderId = await this.driveService.ensureFolder(courseFolderCode);
        const monthFolderName = new Date().toISOString().slice(0, 7);
        const monthFolderId = await this.driveService.ensureFolder(monthFolderName, courseFolderId);

        // Subir a Drive al folder del mes
        const uploadResult = await this.driveService.uploadFile(
          downloadPath,
          filename,
          monthFolderId,
          {
            meetingId: meeting.id,
            courseIdMoodle: courseIdMoodle,
            zoomRecordingId: String(mp4File.id),
            timeoutMs: this.DRIVE_UPLOAD_TIMEOUT_MS,
          }
        );

        // Publicar en Moodle
        const forumId = await this.moodleService.getRecordedForumId(courseIdMoodle);
        const previewLink2 = uploadResult.webViewLink.replace('/view', '/preview');
        const iframe2 = `<div style="max-width: 720px; width: 80vw; margin: 20px auto;"><div style="position: relative; width: 100%; padding-top: 56.25%;"><iframe style="position: absolute; inset: 0; width: 100%; height: 100%; border: 0;" src="${previewLink2}" allow="autoplay; encrypted-media" allowfullscreen="allowfullscreen"></iframe><div style="position: absolute; top: 8px; right: 8px; width: 72px; height: 72px; z-index: 3; background: transparent; cursor: not-allowed;" title="Pop-out deshabilitado" aria-label="Pop-out deshabilitado"></div></div></div>`;
        const moodleResult = await this.moodleService.addForumDiscussion(
          forumId,
          `Grabación disponible: ${meeting.topic}`,
          iframe2
        );

        // Crear o actualizar recording
        let recording = target.recording || target;
        if (!recording.id) {
          recording = this.recRepo.create({
            meetingId: meeting.id,
            zoomRecordingId: mp4File.id,
            driveUrl: uploadResult.webViewLink,
          });
        } else {
          recording.driveUrl = uploadResult.webViewLink;
        }

        await this.recRepo.save(recording);

        this.logger.log(`Full mode completed for zoomMeetingId ${zoomMeetingId}: Drive=${uploadResult.fileId}, Moodle=${moodleResult.discussionid}`);

        return {
          selector,
          mode: 'full',
          status: 'ok',
          reason: 'full-processing-completed',
          courseIdMoodle,
          driveUrl: uploadResult.webViewLink,
          moodlePostId: moodleResult.discussionid,
          integrity: {
            localMd5: await this.md5File(downloadPath),
            driveMd5: uploadResult.md5Checksum,
            sizeBytes: mp4File.file_size,
          },
          meetingId: meeting.id,
          zoomMeetingId,
        };

      } finally {
        // Limpiar archivo temporal
        if (fs.existsSync(downloadPath)) {
          fs.unlinkSync(downloadPath);
          this.logger.debug(`Cleaned up temporary file: ${downloadPath}`);
        }
      }

    } catch (error) {
      this.logger.error(`Full mode failed for selector ${JSON.stringify(selector)}:`, error);

      return {
        selector,
        mode: 'full',
        status: 'failed',
        reason: `full-mode-error: ${error.message}`,
        courseIdMoodle,
        ...this.extractTargetMetadata(target),
      };
    }
  }

  private async withRetries<T>(fn: () => Promise<T>, attempts = 3, backoffMs = 1000): Promise<T> {
    let lastErr: any;
    for (let i = 0; i < attempts; i++) {
      try {
        return await fn();
      } catch (err) {
        lastErr = err;
        await new Promise((r) => setTimeout(r, backoffMs * (i + 1)));
      }
    }
    throw lastErr;
  }

  private async withRobustRetries<T>(label: 'download' | 'upload', fn: (attempt: number) => Promise<T>): Promise<T> {
    const maxAttempts = label === 'download' ? this.MAX_RETRIES_DOWNLOAD : this.MAX_RETRIES_UPLOAD;
    let lastErr: any;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        this.logger.log(`${label === 'download' ? 'Descargando' : 'Subiendo a Drive'} (intento ${attempt}/${maxAttempts}) ...`);
        return await fn(attempt);
      } catch (e: any) {
        lastErr = e;
        const retryIn = this.backoffWithJitter(attempt - 1, this.INITIAL_BACKOFF_MS, this.MAX_BACKOFF_MS);
        this.logger.warn(`${label} fallo: ${e?.message || e}. retryInMs=${retryIn}`);
        if (attempt === maxAttempts) break;
        await this.sleep(retryIn);
      }
    }
    throw lastErr;
  }

  private async ensureDownloadDir() {
    const dir = path.join(process.cwd(), 'downloads');
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
  }

  private async warmupHead(url: string, webhookDownloadToken?: string): Promise<{ contentLength?: number; contentType?: string } | null> {
    try {
      let finalUrl = url;
      // Always use query param for download auth
      const token = webhookDownloadToken || (await this.zoomService.getAccessToken());
      const sep = finalUrl.includes('?') ? '&' : '?';
      finalUrl = `${finalUrl}${sep}access_token=${token}`;

      const res = await axios.head(finalUrl, {
        timeout: this.DOWNLOAD_TIMEOUT_MS || 0,
        httpAgent: new http.Agent({ keepAlive: true }),
        httpsAgent: new https.Agent({ keepAlive: true }),
        headers: { Accept: 'video/mp4, application/octet-stream' },
        validateStatus: () => true,
      });
      if ([404, 409, 425].includes(res.status)) {
        this.logger.warn(`HEAD preliminar status=${res.status}. Reintentará tras espera.`);
        await this.sleep(30000);
        const res2 = await axios.head(finalUrl, {
          timeout: this.DOWNLOAD_TIMEOUT_MS || 0,
          httpAgent: new http.Agent({ keepAlive: true }),
          httpsAgent: new https.Agent({ keepAlive: true }),
          headers: { Accept: 'video/mp4, application/octet-stream' },
          validateStatus: () => true,
        });
        if (res2.status >= 200 && res2.status < 300) {
          const cl = Number(res2.headers['content-length'] || 0) || undefined;
          const ct = String(res2.headers['content-type'] || '') || undefined;
          this.logger.log(`HEAD ok, size=${cl}, type=${ct}`);
          return { contentLength: cl, contentType: ct };
        }
        this.logger.warn(`HEAD aún no listo status=${res2.status}`);
        return null;
      }
      if (res.status >= 200 && res.status < 300) {
        const cl = Number(res.headers['content-length'] || 0) || undefined;
        const ct = String(res.headers['content-type'] || '') || undefined;
        this.logger.log(`HEAD ok, size=${cl}, type=${ct}`);
        return { contentLength: cl, contentType: ct };
      }
      this.logger.warn(`HEAD fallo status=${res.status}`);
      return null;
    } catch (e) {
      this.logger.warn(`HEAD error: ${String((e as any)?.message || e)}`);
      return null;
    }
  }

  private async downloadZoomRecording(
    url: string,
    filePath: string,
    webhookDownloadToken?: string,
  ): Promise<{ contentType?: string; contentLength?: number }> {
    // Always prefer query param token (webhook token if provided; else OAuth)
    const makeUrlWithToken = async (): Promise<string> => {
      const token = webhookDownloadToken || (await this.zoomService.getAccessToken());
      const sep = url.includes('?') ? '&' : '?';
      return `${url}${sep}access_token=${token}`;
    };

    let finalUrl = await makeUrlWithToken();

    // Determine if resuming
    let startByte = 0;
    let flags: 'a' | 'w' = 'w';
    if (fs.existsSync(filePath)) {
      try {
        const st = fs.statSync(filePath);
        if (st.size > 0) {
          startByte = st.size;
          flags = 'a';
        }
      } catch { }
    }

    // Prepare request headers
    const headers: Record<string, string> = {};
    if (startByte > 0) headers['Range'] = `bytes=${startByte}-`;

    const mergedHeaders = { ...(headers || {}), Accept: 'video/mp4, application/octet-stream' } as Record<string, string>;
    const res = await axios.get(finalUrl, {
      responseType: 'stream',
      headers: mergedHeaders,
      timeout: this.DOWNLOAD_TIMEOUT_MS || 0,
      maxContentLength: Infinity as any,
      httpAgent: new http.Agent({ keepAlive: true }),
      httpsAgent: new https.Agent({ keepAlive: true }),
      validateStatus: () => true,
    });

    if ([401, 403].includes(res.status)) {
      // Retry once with refreshed OAuth token (query param)
      const oauth = await this.zoomService.getAccessToken();
      const sep = url.includes('?') ? '&' : '?';
      finalUrl = `${url}${sep}access_token=${oauth}`;
      const res2 = await axios.get(finalUrl, {
        responseType: 'stream',
        headers: mergedHeaders,
        timeout: this.DOWNLOAD_TIMEOUT_MS || 0,
        httpAgent: new http.Agent({ keepAlive: true }),
        httpsAgent: new https.Agent({ keepAlive: true }),
        validateStatus: () => true,
      });
      return await this.handleDownloadResponse(res2, filePath, flags);
    }

    return await this.handleDownloadResponse(res, filePath, flags);
  }

  private async handleDownloadResponse(
    res: AxiosResponse<any>,
    filePath: string,
    flags: 'a' | 'w',
  ): Promise<{ contentType?: string; contentLength?: number }> {
    const status = res.status;
    if (status === 206) this.logger.log('Reanudando descarga (206 Partial Content)');
    if (status === 416) {
      // Rango inválido: reiniciar desde cero en el siguiente intento
      try { if (fs.existsSync(filePath)) fs.unlinkSync(filePath); } catch { }
      throw new Error('Descarga fallo status=416');
    }
    if (status < 200 || status >= 300) {
      throw new Error(`Descarga fallo status=${status}`);
    }

    const contentType = String(res.headers['content-type'] || '') || undefined;
    const contentLength = Number(res.headers['content-length'] || 0) || undefined;

    await new Promise<void>((resolve, reject) => {
      const ws = fs.createWriteStream(filePath, { flags });
      res.data.pipe(ws);
      ws.on('finish', resolve);
      ws.on('error', reject);
    });

    return { contentType, contentLength };
  }

  private async validateDownloadedFile(localPath: string, expectedBytes?: number, contentType?: string): Promise<boolean> {
    if (!fs.existsSync(localPath)) {
      this.logger.warn('Archivo no existe tras la descarga');
      return false;
    }
    const st = fs.statSync(localPath);
    if (st.size <= 0) {
      this.logger.warn('Archivo descargado vacío');
      return false;
    }
    const minBytes = this.MIN_EXPECTED_SIZE_MB * 1024 * 1024;
    if (st.size < minBytes) {
      this.logger.warn(`Archivo demasiado pequeño (${st.size} bytes < ${minBytes}). Posible HTML de error`);
      return false;
    }
    if (expectedBytes) {
      const diff = Math.abs(st.size - expectedBytes) / expectedBytes;
      if (diff > 0.01) {
        this.logger.warn(`Tamaño local difiere de Zoom (local=${st.size} expected=${expectedBytes}). Continuará por tolerancia.`);
        // Solo warn: Zoom puede reportar tamaños que cambian durante procesamiento
      }
    }
    if (contentType) {
      if (contentType.includes('text/html')) {
        this.logger.warn('Content-Type HTML detectado. Descarga inválida');
        return false;
      }
      if (!contentType.includes('video/mp4') && !contentType.includes('application/octet-stream')) {
        this.logger.warn(`Content-Type inesperado: ${contentType}`);
      }
    }
    if (!localPath.toLowerCase().endsWith('.mp4')) {
      this.logger.warn('Extensión no .mp4');
      return false;
    }
    return true;
  }

  private async md5File(filePath: string): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      const hash = createHash('md5');
      const rs = fs.createReadStream(filePath);
      rs.on('data', (chunk) => hash.update(chunk));
      rs.on('end', () => resolve(hash.digest('hex')));
      rs.on('error', reject);
    });
  }

  private backoffWithJitter(attempt: number, base: number, max: number): number {
    const exp = Math.min(max, base * Math.pow(2, attempt));
    const jitter = Math.floor(Math.random() * Math.floor(exp * 0.2)); // +/-20%
    return Math.min(max, exp + jitter);
  }

  private sleep(ms: number) {
    return new Promise((r) => setTimeout(r, ms));
  }

  private getIntEnv(key: string, def: number): number {
    const v = process.env[key];
    if (!v) return def;
    const n = Number(v);
    return Number.isFinite(n) ? n : def;
  }
}
