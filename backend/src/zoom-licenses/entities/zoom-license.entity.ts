import { Entity, PrimaryGeneratedColumn, Column } from 'typeorm';

@Entity('zoom_license')
export class ZoomLicense {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column()
  email: string;

  @Column({ type: 'varchar', default: 'available' })
  status: 'available' | 'occupied';

  @Column({ nullable: true, type: 'uuid' })
  currentMeetingId?: string | null;
}
