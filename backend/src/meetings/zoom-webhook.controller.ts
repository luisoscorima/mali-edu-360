import { Body, Controller, Headers, HttpCode, Logger, Post, Req } from '@nestjs/common';
import { createHmac, timingSafeEqual } from 'crypto';
import { Request } from 'express';
import { RecordingsService } from '../recordings/recordings.service';

@Controller('zoom')
export class ZoomWebhookController {
  private readonly logger = new Logger(ZoomWebhookController.name);
  constructor(private readonly recordingsService: RecordingsService) {}

  /**
   * Zoom Webhook endpoint: validates signature and handles recording.completed
   */
  @Post('webhook')
  @HttpCode(200)
  async handleWebhook(
    @Req() req: Request & { rawBody?: Buffer },
    @Headers('x-zm-request-timestamp') timestamp: string,
    @Headers('x-zm-signature') signature: string,
    @Body() body: any,
  ) {
    // 1) Validate signature
  const secret = process.env.ZOOM_WEBHOOK_SECRET || '';
  const bypass = (process.env.ZOOM_WEBHOOK_DISABLE_SIGNATURE || '').toLowerCase() === 'true';
    if (!secret) {
      // If not configured, reject silently to avoid abuse
      return { status: 'ignored' };
    }

    if (!bypass) {
      const message = `v0:${timestamp}:${(req as any).rawBody?.toString() ?? JSON.stringify(body)}`;
      const hash = createHmac('sha256', secret).update(message).digest('hex');
      const expected = `v0=${hash}`;

      const isValid = (() => {
        try {
          const a = Buffer.from(signature || '');
          const b = Buffer.from(expected);
          return a.length === b.length && timingSafeEqual(a, b);
        } catch {
          return false;
        }
      })();

      if (!isValid) {
        this.logger.warn('Zoom webhook invalid signature');
        return { status: 'invalid-signature' };
      }
    } else {
      this.logger.warn('Zoom webhook signature validation BYPASSED for testing');
    }

    // 2) Event routing
    const event = body?.event as string;
  this.logger.log(`Zoom event received: ${event}`);
  if (event === 'recording.completed') {
      await this.recordingsService.processRecordingCompleted(body);
      return { status: 'ok' };
    }

    return { status: 'ignored' };
  }
}
