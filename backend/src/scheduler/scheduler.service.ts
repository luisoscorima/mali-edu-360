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
		const cutoff = new Date(now.getTime() - 90 * 60 * 1000);

		this.logger.log(`[DriveWakeupJob] start range=${yesterdayLocal.toISOString()}..${todayLocal.toISOString()}`);

		let recs: Recording[] = [];
		try {
			recs = await this.recRepo.createQueryBuilder('r')
				.where('r.createdAt >= :from AND r.createdAt < :to', { from: yesterdayLocal, to: todayLocal })
				.andWhere('r.driveUrl IS NOT NULL')
				.andWhere('r.driveWakeupAttempts < :maxAttempts', { maxAttempts: 2 })
				.andWhere('(r.lastDriveWakeupAt IS NULL OR r.lastDriveWakeupAt <= :cutoff)', { cutoff })
				.getMany();
		} catch (e) {
			this.logger.warn(`[DriveWakeupJob] query-failed err=${(e as any)?.message || e}`);
			return;
		}

		this.logger.log(`[DriveWakeupJob] found ${recs.length} recordings`);

		for (const rec of recs) {
			const fileId = this.extractFileId(rec.driveUrl);
			if (!fileId) continue;

			const attemptNumber = rec.driveWakeupAttempts + 1;
			this.logger.log(
				`[DriveWakeupJob] wakeup recordingId=${rec.id} fileId=${fileId} attempt=${attemptNumber}/2 lastAt=${rec.lastDriveWakeupAt ? rec.lastDriveWakeupAt.toISOString() : 'none'}`,
			);
			try {
				const metaBefore = await this.driveService.getFileMetadata(fileId);
				const beforeProcessed = metaBefore.videoMediaMetadata?.processingStatus === 'ready';
				const beforeThumb = Boolean(metaBefore.thumbnailLink);
				if (beforeThumb && !beforeProcessed) {
					this.logger.log(`[DriveWakeupJob] skip fileId=${fileId} reason=thumbnail-present processing=in-progress attempts=${rec.driveWakeupAttempts}/2`);
					await this.recRepo.update(rec.id, {
						driveWakeupAttempts: 2,
						lastDriveWakeupAt: new Date(),
					});
					continue;
				}

				await this.driveService.wakeUpVideoPreview(fileId);
				const meta = await this.driveService.getFileMetadata(fileId);
				const processed = meta.videoMediaMetadata?.processingStatus === 'ready';
				const hasThumb = Boolean(meta.thumbnailLink);
				this.logger.log(
					`[DriveWakeupJob] result fileId=${fileId} processed=${processed} thumb=${hasThumb} attempts=${attemptNumber}`,
				);
				await this.recRepo.update(rec.id, {
					driveWakeupAttempts: attemptNumber,
					lastDriveWakeupAt: new Date(),
				});
			} catch (e) {
				this.logger.warn(`[DriveWakeupJob] error fileId=${fileId} err=${(e as any)?.message || e}`);
				await this.recRepo.update(rec.id, {
					driveWakeupAttempts: attemptNumber,
					lastDriveWakeupAt: new Date(),
				});
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
