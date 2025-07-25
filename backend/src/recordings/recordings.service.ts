// src/recordings/recordings.service.ts

import { Injectable, Logger } from '@nestjs/common';
import axios from 'axios';
import * as path from 'path';
import * as fs from 'fs';
import { DriveService } from '../drive/drive.service';
import { MoodleService } from '../moodle/moodle.service';

@Injectable()
export class RecordingsService {
  private readonly logger = new Logger(RecordingsService.name);

  constructor(
    private readonly driveService: DriveService,
    private readonly moodleService: MoodleService,
  ) {}

  async processWebhook(data: any) {
    const file = data.payload?.object?.recording_files?.[0];
    const topic = data.payload?.object?.topic as string;
    const courseCode = data.payload?.object?.courseCode as string;

    if (!file?.download_url || !topic || !courseCode) {
      this.logger.warn('Faltan campos en webhook, se ignora');
      return { status: 'ignored' };
    }

    // 1. Descargar el archivo
    const downloadUrl = file.download_url;
    const filename = `${topic.replace(/ /g, '_')}.mp4`;
    const localPath = path.join(process.cwd(), 'downloads', filename);
    await this.ensureDownloadDir();
    await this.downloadFile(downloadUrl, localPath);

    // 2. Subir a Drive (curso → mes)
    const rootDrive = process.env.GDRIVE_SHARED_DRIVE_ID ?? '';
    const courseFolderId = await this.driveService.ensureFolder(courseCode, rootDrive);
    const monthFolderId = await this.driveService.ensureFolder(
      new Date().toISOString().slice(0, 7),
      courseFolderId,
    );
    const driveLink = await this.driveService.uploadFile(localPath, filename, monthFolderId);

    // 3. Buscar el ID numérico de curso en Moodle
    const moodleCourseId = await this.moodleService.findCourseIdByField('shortname', courseCode);

    // 4. Recuperar el forumId de “Clases Grabadas”
    const forumId = await this.moodleService.getRecordedForumId(moodleCourseId);

    // 5. Publicar un nuevo hilo en el foro con un <iframe> embebido
    //   Usamos la URL de preview para que cargue inline
    const previewLink = driveLink.replace('/view', '/preview');
    const iframe = `<iframe
  src="${previewLink}"
  width="640" height="360"
  frameborder="0"
  allow="autoplay; encrypted-media"
  allowfullscreen>
</iframe>`;

    await this.moodleService.addForumDiscussion(forumId, topic, iframe);

    // 6. Limpieza local
    fs.unlinkSync(localPath);

    this.logger.log(`Grabación procesada y publicada en foro: ${previewLink}`);
    return { status: 'done', driveLink: previewLink };
  }

  private async ensureDownloadDir() {
    const dir = path.join(process.cwd(), 'downloads');
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
  }

  private async downloadFile(url: string, filePath: string) {
    const res = await axios.get(url, { responseType: 'stream' });
    return new Promise<void>((resolve, reject) => {
      const ws = fs.createWriteStream(filePath);
      res.data.pipe(ws);
      ws.on('finish', resolve);
      ws.on('error', reject);
    });
  }
}
