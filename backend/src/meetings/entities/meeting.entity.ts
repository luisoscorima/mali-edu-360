import { Entity, PrimaryGeneratedColumn, Column } from 'typeorm';

@Entity('meetings')
export class Meeting {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column()
  topic: string;

  // Moodle numeric course id
  @Column({ type: 'int', nullable: true })
  courseIdMoodle: number;

  // Zoom meeting id (string/number from Zoom)
  @Column()
  zoomMeetingId: string;

  // FK to ZoomLicense (nullable for existing historical rows)
  @Column({ type: 'uuid', nullable: true })
  zoomLicenseId: string;

  @Column({ type: 'timestamp' })
  startTime: Date;

  @Column({ type: 'varchar', default: 'scheduled' })
  status: 'scheduled' | 'completed';

  @Column({ type: 'varchar', nullable: true })
  joinUrl?: string;

  @Column({ type: 'varchar', nullable: true })
  startUrl?: string;
}