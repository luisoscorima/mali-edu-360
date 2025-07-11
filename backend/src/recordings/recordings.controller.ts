import { Controller, Post, Body } from '@nestjs/common';
import { RecordingsService } from './recordings.service';

@Controller('zoom')
export class RecordingsController {
  constructor(private readonly recordingsService: RecordingsService) {}

  @Post('webhook')
  handleWebhook(@Body() body: any) {
    return this.recordingsService.processWebhook(body);
  }
}
