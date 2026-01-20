// src/scheduler/scheduler.service.ts
import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Recording } from '../recordings/entities/recording.entity';
import { DriveService } from '../drive/drive.service';

@Injectable()
export class SchedulerService {
	private readonly logger = new Logger('DriveWakeupJob');

	constructor(
		@InjectRepository(Recording)
		private readonly recRepo: Repository<Recording>,
		private readonly driveService: DriveService,
	) { }

	// Ejecuta a las 02:00 America/Lima todos los días
	@Cron('0 2 * * *', { timeZone: 'America/Lima' })
	async wakeupPreviews(): Promise<void> {
		const now = new Date();
		const todayLocal = new Date(now);
		todayLocal.setHours(0, 0, 0, 0);
		const yesterdayLocal = new Date(todayLocal);
		yesterdayLocal.setDate(yesterdayLocal.getDate() - 1);

		this.logger.log(`[DriveWakeupJob] start range=${yesterdayLocal.toISOString()}..${todayLocal.toISOString()}`);

		let recs: Recording[] = [];
		try {
			recs = await this.recRepo.createQueryBuilder('r')
				.where('r.createdAt >= :from AND r.createdAt < :to', { from: yesterdayLocal, to: todayLocal })
				.andWhere('r.driveUrl IS NOT NULL')
				.getMany();
		} catch (e) {
			this.logger.warn(`[DriveWakeupJob] query-failed err=${(e as any)?.message || e}`);
			return;
		}

		this.logger.log(`[DriveWakeupJob] found ${recs.length} recordings`);

		for (const rec of recs) {
			const fileId = this.extractFileId(rec.driveUrl);
			if (!fileId) continue;

			this.logger.log(`[DriveWakeupJob] wakeup recordingId=${rec.id} fileId=${fileId}`);
			try {
				await this.driveService.wakeUpVideoPreview(fileId);
				const meta = await this.driveService.getFileMetadata(fileId);
				const processed = meta.videoMediaMetadata?.processingStatus === 'ready';
				const hasThumb = Boolean(meta.thumbnailLink);
				this.logger.log(`[DriveWakeupJob] result fileId=${fileId} processed=${processed} thumb=${hasThumb}`);
			} catch (e) {
				this.logger.warn(`[DriveWakeupJob] error fileId=${fileId} err=${(e as any)?.message || e}`);
			}
		}

		this.logger.log('[DriveWakeupJob] completed');
	}

	private extractFileId(url: string | null | undefined): string | null {
		if (!url) return null;
		const byPath = /\/file\/d\/([a-zA-Z0-9_-]+)/.exec(url);
		if (byPath && byPath[1]) return byPath[1];
		const byQuery = /[?&]id=([^&#]+)/.exec(url);
		if (byQuery && byQuery[1]) return byQuery[1];
		return null;
	}
}
