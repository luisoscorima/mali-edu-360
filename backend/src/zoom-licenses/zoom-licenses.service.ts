import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { ZoomLicense } from './entities/zoom-license.entity';
import { Repository } from 'typeorm';

@Injectable()
export class ZoomLicensesService {
  constructor(
    @InjectRepository(ZoomLicense)
    private licenseRepo: Repository<ZoomLicense>,
  ) { }

  async getAvailableLicense(): Promise<ZoomLicense> {
    const license = await this.licenseRepo.findOneBy({ status: 'available' });
    if (!license) throw new Error('No Zoom licenses available');
    return license;
  }

  async markAsOccupied(licenseId: string, meetingId: string) {
    await this.licenseRepo.update(licenseId, {
      status: 'occupied',
      currentMeetingId: meetingId,
    });
  }

  async releaseLicense(meetingId: string) {
    await this.licenseRepo.update(
      { currentMeetingId: meetingId },
      { status: 'available', currentMeetingId: null as any },
    );
  }
}
