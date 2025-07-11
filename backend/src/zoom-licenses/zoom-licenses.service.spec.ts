import { Test, TestingModule } from '@nestjs/testing';
import { ZoomLicensesService } from './zoom-licenses.service';

describe('ZoomLicensesService', () => {
  let service: ZoomLicensesService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [ZoomLicensesService],
    }).compile();

    service = module.get<ZoomLicensesService>(ZoomLicensesService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });
});
