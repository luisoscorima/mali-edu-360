// src/drive/drive.service.ts

import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { google, drive_v3 } from 'googleapis';
import * as path from 'path';
import { ConfigService } from '@nestjs/config';
import * as fs from 'fs';

@Injectable()
export class DriveService implements OnModuleInit {
  private readonly logger = new Logger(DriveService.name);
  private drive!: drive_v3.Drive;
  private sharedDriveId!: string;

  constructor(private readonly config: ConfigService) {}

  onModuleInit() {
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

  /** Sube archivo y devuelve link embebible */
  async uploadFile(
    filePath: string,
    filename: string,
    folderId: string,
  ): Promise<string> {
    const res = await this.drive.files.create({
      requestBody: {
        name: filename,
        parents: [folderId],
      },
      media: {
        mimeType: 'video/mp4',
        body: fs.createReadStream(filePath),
      },
      fields: 'id, webViewLink',
      supportsAllDrives: true,
    });

    this.logger.log(`Archivo subido a Drive (ID=${res.data.id})`);
    return res.data.webViewLink!;
  }
}
