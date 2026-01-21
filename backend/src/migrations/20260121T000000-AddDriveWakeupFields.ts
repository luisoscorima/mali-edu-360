import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddDriveWakeupFields20260121T000000 implements MigrationInterface {
  name = 'AddDriveWakeupFields20260121T000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "recordings" ADD "driveWakeupAttempts" integer NOT NULL DEFAULT 0`);
    await queryRunner.query(`ALTER TABLE "recordings" ADD "lastDriveWakeupAt" TIMESTAMP NULL`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "recordings" DROP COLUMN "lastDriveWakeupAt"`);
    await queryRunner.query(`ALTER TABLE "recordings" DROP COLUMN "driveWakeupAttempts"`);
  }
}
