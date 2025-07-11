import { Injectable, Logger } from '@nestjs/common';
import axios from 'axios';
import * as fs from 'fs';
import * as path from 'path';

@Injectable()
export class RecordingsService {
  private readonly logger = new Logger(RecordingsService.name);

  async processWebhook(data: any) {
    const recording = data.payload?.object?.recording_files?.[0];
    const topic = data.payload?.object?.topic;

    if (!recording?.download_url) {
      this.logger.warn('No download_url found');
      return { status: 'ignored' };
    }

    const downloadUrl = recording.download_url;
    const filename = `${topic.replace(/ /g, '_')}.mp4`;
    const filePath = path.join(__dirname, '../../downloads', filename);

    try {
      const response = await axios.get(downloadUrl, { responseType: 'stream' });
      await new Promise<void>((resolve, reject) => {
        const writer = fs.createWriteStream(filePath);
        response.data.pipe(writer);
        writer.on('finish', resolve);
        writer.on('error', reject);
      });

      return { status: 'downloaded', filePath };
    } catch (err) {
      this.logger.error('Failed to download recording', err);
      return { status: 'error', error: err.message };
    }
  }
}
