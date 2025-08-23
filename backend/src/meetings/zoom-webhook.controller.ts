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
    const secret = process.env.ZOOM_WEBHOOK_SECRET || '';
    const bypass = (process.env.ZOOM_WEBHOOK_DISABLE_SIGNATURE || '').toLowerCase() === 'true';

    // Normalize body when body-parser.raw is used (Buffer) to still access event/payload
    let eventBody: any = body;
    if (Buffer.isBuffer(body)) {
      try { eventBody = JSON.parse(body.toString('utf8')); } catch { eventBody = {}; }
    }

    // 1) Event routing (handle URL validation first)
    const event = eventBody?.event as string;
    this.logger.log(`Zoom event received: ${event}`);

    if (event === 'endpoint.url_validation') {
      if (!secret) {
        this.logger.warn('URL validation requested but ZOOM_WEBHOOK_SECRET is not set');
        return { status: 'ignored' };
      }
      // Zoom handshake: echo plainToken and return encryptedToken = HMAC_SHA256(secret, plainToken)
      const plainToken: string | undefined = eventBody?.payload?.plainToken;
      if (!plainToken) {
        this.logger.warn('URL validation without plainToken');
        return { status: 'ignored' };
      }
  // Per Zoom docs, encryptedToken must be HMAC-SHA256(plainToken, secret) HEX-encoded
  const encryptedToken = createHmac('sha256', secret).update(plainToken).digest('hex');
      return { plainToken, encryptedToken } as any;
    }

    // 2) Validate signature for real events
    if (!secret) {
      // If not configured, reject silently to avoid abuse
      return { status: 'ignored' };
    }

    if (!bypass) {
  const raw = (req as any).rawBody?.toString() ?? (Buffer.isBuffer(body) ? body.toString('utf8') : JSON.stringify(eventBody));
      const message = `v0:${timestamp}:${raw}`;
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

    // 3) Process events
    if (event === 'recording.completed') {
      await this.recordingsService.processRecordingCompleted(eventBody);
      return { status: 'ok' };
    }

    return { status: 'ignored' };
  }
}
