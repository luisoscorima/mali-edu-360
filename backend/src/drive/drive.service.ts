// src/drive/drive.service.ts

import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { google, drive_v3 } from 'googleapis';
import * as path from 'path';
import { ConfigService } from '@nestjs/config';
import * as fs from 'fs';
import axios from 'axios';
import * as http from 'http';
import * as https from 'https';

@Injectable()
export class DriveService implements OnModuleInit {
  private readonly logger = new Logger(DriveService.name);
  private drive!: drive_v3.Drive;
  private sharedDriveId!: string;
  private authClient!: any;

  constructor(private readonly config: ConfigService) {}

  async onModuleInit() {
    // 1. Leer y validar env vars
    const credsPath = this.config.get<string>('GDRIVE_CREDENTIALS_PATH');
    const sharedDriveId = this.config.get<string>('GDRIVE_SHARED_DRIVE_ID');
    if (!credsPath || !sharedDriveId) {
      throw new Error(
        'GDRIVE_CREDENTIALS_PATH y GDRIVE_SHARED_DRIVE_ID deben estar definidos',
      );
    }
    this.sharedDriveId = sharedDriveId;

    // 2. Inicializar GoogleAuth con el JSON
    const fullPath = path.resolve(process.cwd(), credsPath);
  const auth = new google.auth.GoogleAuth({
      keyFile: fullPath,
      scopes: ['https://www.googleapis.com/auth/drive'],
    });

  this.drive = google.drive({ version: 'v3', auth });
  this.authClient = await auth.getClient();
    this.logger.log(`DriveService iniciado con credenciales: ${fullPath}`);
  }

  /** Busca o crea carpeta en Shared Drive */
  async ensureFolder(name: string, parentId?: string): Promise<string> {
    const driveId = this.sharedDriveId;
    const parent = parentId ?? driveId;

    // Primero intentamos listar la carpeta
    const listRes = await this.drive.files.list({
      q: `name='${name}' and '${parent}' in parents and mimeType='application/vnd.google-apps.folder' and trashed=false`,
      corpora: 'drive',               // obligatorio para Shared Drives
      driveId: driveId,              // tu ID de Shared Drive
      includeItemsFromAllDrives: true,
      supportsAllDrives: true,
      fields: 'files(id)',
    });

    if (listRes.data.files?.length) {
      return listRes.data.files[0].id!;
    }

    // Si no existe, la creamos
    const folderRes = await this.drive.files.create({
      requestBody: {
        name,
        mimeType: 'application/vnd.google-apps.folder',
        parents: [parent],
      },
      fields: 'id',
      supportsAllDrives: true,
    });

    this.logger.log(`Carpeta creada: ${name} (ID=${folderRes.data.id})`);
    return folderRes.data.id!;
  }

  /**
   * Sube archivo a Drive usando Resumable Upload.
   * - Reintenta ante 429/5xx.
   * - Aplica permisos anyone-reader.
   * - Agrega appProperties con metadatos.
   * Devuelve: { fileId, webViewLink, md5Checksum }
   */
  async uploadFile(
    filePath: string,
    filename: string,
    folderId: string,
    opts?: { meetingId?: string; courseIdMoodle?: number; zoomRecordingId?: string; timeoutMs?: number }
  ): Promise<{ fileId: string; webViewLink: string; md5Checksum?: string }> {
    const stat = fs.statSync(filePath);
    const total = stat.size;
    const chunkSize = this.getIntEnv('CHUNK_SIZE_MB', 32) * 1024 * 1024;
    const timeout = Number(opts?.timeoutMs ?? this.getIntEnv('DRIVE_UPLOAD_TIMEOUT_MS', 0));

    // 1) Iniciar sesión resumable
    const sessionUrl = await this.startResumableSession({
      name: filename,
      parents: [folderId],
      appProperties: {
        uploadedBy: 'pipeline',
        ...(opts?.meetingId ? { meetingId: opts.meetingId } : {}),
        ...(opts?.courseIdMoodle ? { courseIdMoodle: String(opts.courseIdMoodle) } : {}),
        ...(opts?.zoomRecordingId ? { zoomRecordingId: opts.zoomRecordingId } : {}),
      },
      mimeType: 'video/mp4',
      size: total,
      timeout,
    });

    // 2) Enviar chunks con PUT y Content-Range
    let offset = 0;
    while (offset < total) {
      const end = Math.min(offset + chunkSize, total) - 1;
      const contentLength = end - offset + 1;

      const headers: Record<string, any> = {
        'Content-Length': contentLength,
        'Content-Type': 'video/mp4',
        'Content-Range': `bytes ${offset}-${end}/${total}`,
      };

      const stream = fs.createReadStream(filePath, { start: offset, end });

      const res = await this.withUploadRetries(async () => {
        return axios.put(sessionUrl, stream, {
          headers,
          maxBodyLength: Infinity,
          timeout: timeout || 0,
          httpAgent: new http.Agent({ keepAlive: true }),
          httpsAgent: new https.Agent({ keepAlive: true }),
          validateStatus: () => true,
        });
      });

      if (res.status === 308) {
        // Resume Incomplete; avanzar según Range
        const range = res.headers['range'] as string | undefined;
        if (range) {
          const m = /bytes=\d+-(\d+)/.exec(range);
          if (m) offset = parseInt(m[1], 10) + 1; else offset = end + 1;
        } else {
          offset = end + 1;
        }
        this.logger.log(`Subiendo a Drive… offset=${offset}/${total}`);
        continue;
      }

      if (res.status >= 200 && res.status < 300) {
        // Upload complete
        break;
      }

      throw new Error(`Resumable upload fallo status=${res.status}`);
    }

    // 3) Obtener metadata (md5Checksum/webViewLink)
    const query = await this.drive.files.list({
      q: `name='${filename}' and '${folderId}' in parents and trashed=false`,
      corpora: 'drive',
      driveId: this.sharedDriveId,
      includeItemsFromAllDrives: true,
      supportsAllDrives: true,
      fields: 'files(id, webViewLink, md5Checksum)',
    });
    const file = query.data.files?.[0];
    if (!file?.id) throw new Error('No se encontró archivo tras upload');

    const fileId = file.id;

    // 4) Permisos: anyone with link (reader) + restricción de descarga
    try {
      await this.drive.permissions.create({
        fileId,
        requestBody: { role: 'reader', type: 'anyone' },
        supportsAllDrives: true,
      });
      
      // Actualizar archivo para restringir descarga
      await this.drive.files.update({
        fileId,
        requestBody: { copyRequiresWriterPermission: true },
        supportsAllDrives: true,
      });
      
      this.logger.log(`Permisos actualizados: anyone with link (reader) + sin descarga`);
    } catch (e) {
      this.logger.warn(`No se pudo configurar permisos del archivo: ${fileId} -> ${String((e as any)?.message || e)}`);
    }

    this.logger.log(`Archivo subido a Drive (ID=${fileId})`);
    return { fileId, webViewLink: file.webViewLink!, md5Checksum: file.md5Checksum || undefined };
  }

  /** Busca por appProperties.zoomRecordingId en el Shared Drive */
  async findFileByZoomRecordingId(zoomRecordingId: string): Promise<{ fileId: string; webViewLink: string; md5Checksum?: string } | null> {
    const q = `appProperties has { key='zoomRecordingId' and value='${zoomRecordingId}' } and trashed=false`;
    const res = await this.drive.files.list({
      q,
      corpora: 'drive',
      driveId: this.sharedDriveId,
      includeItemsFromAllDrives: true,
      supportsAllDrives: true,
      fields: 'files(id, webViewLink, md5Checksum)',
    });
    const f = res.data.files?.[0];
    if (!f) return null;
    return { fileId: f.id!, webViewLink: f.webViewLink!, md5Checksum: f.md5Checksum || undefined };
  }

  private async startResumableSession(args: { name: string; parents: string[]; appProperties: Record<string, string>; mimeType: string; size: number; timeout?: number }): Promise<string> {
    // Build URL
    const url = `https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&supportsAllDrives=true`;
    const token = await this.getAccessToken();
    const headers = {
      Authorization: `Bearer ${token}`,
      'X-Upload-Content-Type': args.mimeType,
      'X-Upload-Content-Length': String(args.size),
      'Content-Type': 'application/json; charset=UTF-8',
    };
    const body = {
      name: args.name,
      parents: args.parents,
      appProperties: args.appProperties,
      copyRequiresWriterPermission: true, // Evita descarga por lectores
    } as any;

    const res = await axios.post(url, body, {
      headers,
      timeout: args.timeout || 0,
      httpAgent: new http.Agent({ keepAlive: true }),
      httpsAgent: new https.Agent({ keepAlive: true }),
      validateStatus: () => true,
    });

    if (res.status < 200 || res.status >= 300) {
      throw new Error(`No se pudo iniciar sesión resumable (status=${res.status})`);
    }
    const location = res.headers['location'];
    if (!location) throw new Error('Respuesta sin Location para sesión resumable');
    return String(location);
  }

  private async withUploadRetries<T>(fn: () => Promise<import('axios').AxiosResponse<T>>): Promise<import('axios').AxiosResponse<T>> {
    const maxRetries = this.getIntEnv('MAX_RETRIES_UPLOAD', 10);
    const base = this.getIntEnv('INITIAL_BACKOFF_MS', 15000);
    const max = this.getIntEnv('MAX_BACKOFF_MS', 300000);
    let lastErr: any;
    for (let i = 0; i < maxRetries; i++) {
      try {
        const res = await fn();
        if ([429].includes((res as any).status) || (res as any).status >= 500) {
          throw new Error(`status=${(res as any).status}`);
        }
        return res;
      } catch (e: any) {
        lastErr = e;
        const delay = Math.min(max, base * Math.pow(2, i)) + Math.floor(Math.random() * 1000);
        this.logger.warn(`Upload retry in ${delay}ms: ${e?.message || e}`);
        await new Promise((r) => setTimeout(r, delay));
      }
    }
    throw lastErr;
  }

  private async getAccessToken(): Promise<string> {
    const token = await this.authClient.getAccessToken();
    return typeof token === 'string' ? token : token?.token || '';
  }

  private getIntEnv(key: string, def: number): number {
    const v = process.env[key];
    if (!v) return def;
    const n = Number(v);
    return Number.isFinite(n) ? n : def;
  }
}
