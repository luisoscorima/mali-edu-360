import { Column, CreateDateColumn, Entity, PrimaryGeneratedColumn } from 'typeorm';

@Entity('recordings')
export class Recording {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  // FK logical reference to our internal Meeting (uuid)
  @Column({ type: 'uuid' })
  meetingId: string;

  // Zoom recording file id
  @Column({ type: 'varchar' })
  zoomRecordingId: string;

  // Public/private Drive URL where the video is stored
  @Column({ type: 'varchar' })
  driveUrl: string;

  @CreateDateColumn({ type: 'timestamp with time zone' })
  createdAt: Date;

  @Column({ type: 'timestamp', nullable: true })
  lastRetryAt?: Date;

  @Column({ type: 'int', default: 0 })
  retryCount: number;

  @Column({ type: 'int', default: 0 })
  driveWakeupAttempts: number;

  @Column({ type: 'timestamp', nullable: true })
  lastDriveWakeupAt?: Date;
}