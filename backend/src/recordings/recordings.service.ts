import { Injectable, Logger } from '@nestjs/common';
import axios, { AxiosResponse } from 'axios';
import * as path from 'path';
import * as fs from 'fs';
import * as https from 'https';
import * as http from 'http';
import { createHash } from 'crypto';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { DriveService } from '../drive/drive.service';
import { MoodleService } from '../moodle/moodle.service';
import { Recording } from './entities/recording.entity';
import { ZoomLicensesService } from '../zoom-licenses/zoom-licenses.service';
import { Meeting } from '../meetings/entities/meeting.entity';
import { ZoomService } from '../meetings/zoom.service';

@Injectable()
export class RecordingsService {
  private readonly logger = new Logger(RecordingsService.name);
  // Simple in-memory lock to avoid concurrent processing for the same meeting
  private readonly inFlightMeetings = new Set<string>();

  // Config defaults (overridable via env)
  private readonly MAX_RETRIES_DOWNLOAD = this.getIntEnv('MAX_RETRIES_DOWNLOAD', 10);
  private readonly MAX_RETRIES_UPLOAD = this.getIntEnv('MAX_RETRIES_UPLOAD', 10);
  private readonly INITIAL_BACKOFF_MS = this.getIntEnv('INITIAL_BACKOFF_MS', 15000);
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
  ) {}

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

    // Map Zoom meeting to our Meeting entity
  const meeting = await this.meetingRepo.findOne({ where: { zoomMeetingId } });
    if (!meeting) {
      this.logger.warn(`No se encontró Meeting para zoomMeetingId=${zoomMeetingId}`);
      if (zoomMeetingId) this.inFlightMeetings.delete(zoomMeetingId);
      return { status: 'ignored' };
    }
  this.logger.log(`Meeting encontrado: id=${meeting.id}, courseIdMoodle=${meeting.courseIdMoodle}`);

    // Process the first MP4 recording file
    const mp4 = files.find((f) => f.file_type === 'MP4' && f.download_url);
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
      await this.meetingRepo.update(meeting.id, { status: 'completed' as any });
      await this.zoomLicenses.releaseLicense(meeting.id);
      return { status: 'done', driveUrl: existing.driveUrl };
    }
    const existingDrive = await this.driveService.findFileByZoomRecordingId(zoomRecordingId);
    if (existingDrive) {
      this.logger.log(`Idempotente: archivo ya en Drive por zoomRecordingId=${zoomRecordingId}. Creando registro en DB y cerrando flujo.`);
      const rec = this.recRepo.create({ meetingId: meeting.id, zoomRecordingId, driveUrl: existingDrive.webViewLink });
      await this.recRepo.save(rec);
      await this.meetingRepo.update(meeting.id, { status: 'completed' as any });
      await this.zoomLicenses.releaseLicense(meeting.id);
  return { status: 'done', driveUrl: existingDrive.webViewLink };
    }

    // 1) Download with retries (long-running, resumable)
  const filename = `${(topic || 'Clase').replace(/[^a-zA-Z0-9-_]/g, '_')}_${new Date().toISOString().slice(0, 10)}.mp4`;
    const localPath = path.join(process.cwd(), 'downloads', filename);
    await this.ensureDownloadDir();
  this.logger.log(`Descargando grabación desde Zoom a: ${localPath}`);

    const dlStartedAt = Date.now();
    const headInfo = await this.warmupHead(mp4.download_url, downloadToken);
    if (headInfo && headInfo.contentLength && expectedBytes && Math.abs(headInfo.contentLength - expectedBytes) / expectedBytes > 0.01) {
      this.logger.warn(`HEAD size difiere de payload: head=${headInfo.contentLength} payload=${expectedBytes}`);
    }
    await this.withRobustRetries('download', async (attempt) => {
      const info = await this.downloadZoomRecording(mp4.download_url, localPath, downloadToken);
      // Pre-upload validations
  const ok = await this.validateDownloadedFile(localPath, expectedBytes, info.contentType);
      if (!ok) {
        // Eliminar archivo parcial para que el siguiente intento no use Range inválido
        try { fs.unlinkSync(localPath); } catch {}
        throw new Error('Archivo descargado inválido o incompleto');
      }
    });
    const dlMs = Date.now() - dlStartedAt;
    const { size: finalDownloadSize } = fs.statSync(localPath);
    this.logger.log(`Descarga completa (${finalDownloadSize} bytes) en ${Math.round(dlMs / 1000)}s.`);

    // 2) Upload to Drive into course folder + yyyy-mm
  const courseFolderCode = String(meeting.courseIdMoodle);
  const rootDrive = process.env.GDRIVE_SHARED_DRIVE_ID ?? '';
  const courseFolderId = await this.driveService.ensureFolder(courseFolderCode, rootDrive);
  this.logger.log(`Carpeta curso en Drive: ${courseFolderCode} -> ${courseFolderId}`);
    const monthFolderId = await this.driveService.ensureFolder(new Date().toISOString().slice(0, 7), courseFolderId);
    const upStartedAt = Date.now();
    const upload = await this.withRobustRetries('upload', async (attempt) => {
      const res = await this.driveService.uploadFile(localPath, filename, monthFolderId, {
        meetingId: meeting.id,
        courseIdMoodle: meeting.courseIdMoodle!,
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

  const forumId = await this.moodleService.getRecordedForumId(meeting.courseIdMoodle!);
  this.logger.log(`Publicando en foro Moodle ${forumId} del curso ${meeting.courseIdMoodle}`);
    const previewLink = driveLink.replace('/view', '/preview');
    const iframe = `<iframe src="${previewLink}" width="640" height="360" frameborder="0" allow="autoplay; encrypted-media" allowfullscreen></iframe>`;
    const subject = `${topic || 'Clase grabada'} [${zoomRecordingId}]`;
    await this.withRobustRetries('upload', async () => {
      await this.moodleService.addForumDiscussion(forumId, subject, iframe);
    });

    // 4) Persist Recording
    const rec = this.recRepo.create({
      meetingId: meeting.id,
      zoomRecordingId,
      driveUrl: driveLink,
    });
    await this.recRepo.save(rec);

    // 5) Update meeting and release license
  await this.meetingRepo.update(meeting.id, { status: 'completed' as any });
    await this.zoomLicenses.releaseLicense(meeting.id);

    // 6) Cleanup local file
    try { fs.unlinkSync(localPath); } catch {}

    this.logger.log(`Pipeline OK | tiempo total: descarga ${Math.round(dlMs/1000)}s + subida ${Math.round(upMs/1000)}s`);
    this.logger.log(`Grabación procesada y publicada: ${previewLink}`);
    return { status: 'done', driveUrl: driveLink };
    } finally {
      if (zoomMeetingId) this.inFlightMeetings.delete(zoomMeetingId);
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
      } catch {}
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
      try { if (fs.existsSync(filePath)) fs.unlinkSync(filePath); } catch {}
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
