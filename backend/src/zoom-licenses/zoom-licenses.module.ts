import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ZoomLicense } from './entities/zoom-license.entity';
import { ZoomLicensesService } from './zoom-licenses.service';

@Module({
  imports: [TypeOrmModule.forFeature([ZoomLicense])],
  providers: [ZoomLicensesService],
  exports: [ZoomLicensesService],
})
export class ZoomLicensesModule {}
