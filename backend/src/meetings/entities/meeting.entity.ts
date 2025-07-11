import { Entity, PrimaryGeneratedColumn, Column } from 'typeorm';

@Entity('meetings')
export class Meeting {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column()
  topic: string;

  @Column()
  courseId: string;

  @Column()
  userId: string;

  @Column()
  zoomMeetingId: string;

  @Column()
  licenseId: string;

  @Column({ type: 'timestamp' })
  startTime: Date;

  @Column({ type: 'timestamp' })
  endTime: Date;

  @Column({ type: 'varchar' })
  status: 'scheduled' | 'live' | 'finished';
}
