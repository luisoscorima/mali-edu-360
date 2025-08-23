import { Controller, Post, Body, Get, Query, Param } from '@nestjs/common';
import { IsString, IsOptional, IsBoolean, IsNumber, IsDateString, Min, Max } from 'class-validator';
import { ZoomSyncService, SyncResult } from './zoom-sync.service';
import { ZoomRecordingsService } from '../zoom/zoom-recordings.service';
import { ConfigService } from '@nestjs/config';
import { DriveService } from '../drive/drive.service';
import { MoodleService } from '../moodle/moodle.service';

export class SyncZoomRecordingsDto {
  @IsDateString()
  from: string; // YYYY-MM-DD

  @IsDateString()
  to: string; // YYYY-MM-DD

  @IsOptional()
  @IsBoolean()
  dryRun?: boolean;

  @IsOptional()
  @IsNumber()
  @Min(1)
  @Max(100)
  maxPages?: number;

  @IsOptional()
  @IsBoolean()
  onlyMissingMeetings?: boolean;
}

export class GetRecordingsToRetryDto {
  @IsOptional()
  @IsDateString()
  from?: string;

  @IsOptional()
  @IsDateString()
  to?: string;

  @IsOptional()
  @IsBoolean()
  onlyWithoutDriveUrl?: boolean;

  @IsOptional()
  @IsNumber()
  @Min(1)
  @Max(200)
  limit?: number;
}

@Controller('admin/zoom')
export class AdminZoomController {
  constructor(
    private readonly zoomSyncService: ZoomSyncService,
    private readonly zoomRecordingsService: ZoomRecordingsService,
    private readonly configService: ConfigService,
    private readonly driveService: DriveService,
  private readonly moodleService: MoodleService,
  ) {}

  @Post('sync-recordings')
  async syncRecordings(@Body() dto: SyncZoomRecordingsDto): Promise<SyncResult> {
    return this.zoomSyncService.syncZoomRecordings({
      from: dto.from,
      to: dto.to,
      dryRun: dto.dryRun,
      maxPages: dto.maxPages,
      onlyMissingMeetings: dto.onlyMissingMeetings,
    });
  }

  @Get('recordings-to-retry')
  async getRecordingsToRetry(@Query() dto: GetRecordingsToRetryDto) {
    return this.zoomSyncService.getRecordingsToRetry({
      from: dto.from,
      to: dto.to,
      onlyWithoutDriveUrl: dto.onlyWithoutDriveUrl,
      limit: dto.limit,
    });
  }

  @Get('test-api')
  async testZoomApi(@Query('from') from: string, @Query('to') to: string) {
    try {
      const token = await this.zoomRecordingsService.getAccessToken();
      const recordings = await this.zoomRecordingsService.listRecordings({
        from,
        to,
        pageSize: 10,
      });
      
      return {
        success: true,
        token: token ? 'Token obtained successfully' : 'No token',
        recordingsFound: recordings.meetings?.length || 0,
        recordings: recordings.meetings?.slice(0, 3) || [], // Solo los primeros 3 para no saturar
        totalRecords: recordings.total_records,
        pageInfo: {
          pageCount: recordings.page_count,
          pageNumber: recordings.page_number,
        }
      };
    } catch (error) {
      return {
        success: false,
        error: error.message,
        details: error.stack
      };
    }
  }

  @Get('search-meeting')
  async searchSpecificMeeting(@Query('meetingId') meetingId: string) {
    try {
      const recording = await this.zoomRecordingsService.getRecordingById(meetingId);
      return {
        success: true,
        found: !!recording,
        recording: recording || null
      };
    } catch (error) {
      return {
        success: false,
        error: error.message
      };
    }
  }

  @Get('test-drive')
  async testDriveAccess() {
    try {
      // Importar DriveService aquí
      const { DriveService } = await import('../drive/drive.service');
      const driveService = new (DriveService as any)(this.configService);
      
      // Intentar obtener un token de acceso
      const token = await (driveService as any).getAccessToken();
      
      // Probar una búsqueda simple
      const testFile = await driveService.findByAppProperty('testProperty', 'testValue');
      
      return {
        success: true,
        token: token ? 'Token obtained successfully' : 'No token',
        driveTest: 'File search completed',
        result: testFile || 'No file found (normal)'
      };
    } catch (error) {
      return {
        success: false,
        error: error.message,
        details: error.stack
      };
    }
  }

  @Get('test-direct-api')
  async testDirectZoomApi() {
    try {
      const token = await this.zoomRecordingsService.getAccessToken();
      
      // Probar llamada directa a la API de usuarios para verificar permisos
      const response = await fetch('https://api.zoom.us/v2/users', {
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json'
        }
      });
      
      const userData = await response.json();
      
      return {
        success: true,
        token: token ? 'Token obtained successfully' : 'No token',
        apiResponse: userData,
        statusCode: response.status
      };
    } catch (error) {
      return {
        success: false,
        error: error.message,
        details: error.stack
      };
    }
  }

  @Get('deep-debug')
  async deepDebugRecordings() {
    try {
      const token = await this.zoomRecordingsService.getAccessToken();
      
      // Primero, intentar obtener la lista de usuarios para ver si podemos iterar por cada uno
      const usersResponse = await fetch('https://api.zoom.us/v2/users?page_size=30', {
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json'
        }
      });
      
      const usersData = await usersResponse.json();
      
      if (!usersData.users || usersData.users.length === 0) {
        return {
          success: false,
          error: 'No users found',
          usersData
        };
      }
      
      // Intentar buscar grabaciones para cada usuario
      const userRecordings: any[] = [];
      
      for (const user of usersData.users.slice(0, 3)) { // Solo los primeros 3 usuarios
        try {
          const recordingsResponse = await fetch(
            `https://api.zoom.us/v2/users/${user.id}/recordings?from=2025-08-01&to=2025-08-22&page_size=30`,
            {
              headers: {
                'Authorization': `Bearer ${token}`,
                'Content-Type': 'application/json'
              }
            }
          );
          
          const recordings = await recordingsResponse.json();
          
          userRecordings.push({
            userId: user.id,
            userEmail: user.email,
            statusCode: recordingsResponse.status,
            recordingsFound: recordings.meetings?.length || 0,
            recordings: recordings.meetings?.slice(0, 2) || [], // Solo los primeros 2
            totalRecords: recordings.total_records || 0,
            error: recordings.code ? recordings.message : null
          });
        } catch (userError) {
          userRecordings.push({
            userId: user.id,
            userEmail: user.email,
            error: userError.message
          });
        }
      }
      
      return {
        success: true,
        token: 'Token obtained successfully',
        totalUsers: usersData.users.length,
        userRecordings
      };
    } catch (error) {
      return {
        success: false,
        error: error.message,
        details: error.stack
      };
    }
  }

  @Post('test-drive')
  async testDrive(): Promise<any> {
    try {
      // 1. Test authentication
      const auth = (this.driveService as any).authClient;
      const token = await auth?.getAccessToken();
      
      // 2. Test basic API call
      const drive = (this.driveService as any).drive;
      const aboutRes = await drive.about.get({ fields: 'user' });
      
      // 3. Test Shared Drive access
      const sharedDriveId = this.configService.get<string>('GDRIVE_SHARED_DRIVE_ID');
      const driveInfoRes = await drive.drives.get({ driveId: sharedDriveId });
      
      // 4. Test folder listing
      const foldersRes = await drive.files.list({
        q: `'${sharedDriveId}' in parents and mimeType='application/vnd.google-apps.folder' and trashed=false`,
        corpora: 'drive',
        driveId: sharedDriveId,
        includeItemsFromAllDrives: true,
        supportsAllDrives: true,
        fields: 'files(id, name)',
      });

      return {
        success: true,
        auth: {
          hasToken: !!token,
          tokenType: typeof token
        },
        about: aboutRes.data,
        sharedDrive: {
          id: sharedDriveId,
          info: driveInfoRes.data
        },
        folders: {
          count: foldersRes.data.files?.length || 0,
          folders: foldersRes.data.files?.slice(0, 5) // First 5 folders
        }
      };
    } catch (error) {
      return {
        success: false,
        error: error.message,
        details: error.stack
      };
    }
  }

  @Post('test-drive-upload')
  async testDriveUpload(): Promise<any> {
    try {
      const folderId = await this.driveService.ensureFolder('debug-upload');
      const start = Date.now();
      let sessionUrl: string | null = null;
      try {
        sessionUrl = await (this.driveService as any).startResumableSession({
          name: `debug-${Date.now()}.txt`,
          parents: [folderId],
          appProperties: { purpose: 'debug' },
          mimeType: 'text/plain',
          size: 6,
          timeout: 15000,
        });
      } catch (e: any) {
        return {
          success: false,
          step: 'startResumableSession',
          error: e?.message || String(e),
          elapsedMs: Date.now() - start,
          folderId,
        };
      }

      return {
        success: true,
        folderId,
        sessionUrl,
        elapsedMs: Date.now() - start,
      };
    } catch (error: any) {
      return {
        success: false,
        error: error.message,
        details: error.stack,
      };
    }
  }

  @Get('debug-moodle-forums')
  async debugMoodleForums(@Query('courseId') courseIdStr: string) {
    const courseId = Number(courseIdStr);
    if (!Number.isFinite(courseId) || courseId <= 0) {
      return { success: false, error: 'Invalid courseId' };
    }
    try {
      const forums = await this.moodleService.getForumsByCourse(courseId);
      const contents = await this.moodleService.getCourseContents(courseId);
      const forumModules = (Array.isArray(contents) ? contents : [])
        .flatMap((s: any) => Array.isArray(s.modules) ? s.modules : [])
        .filter((m: any) => m.modname === 'forum')
        .map((m: any) => ({ name: m.name, instance: m.instance }));
      return { success: true, forums, forumModules };
    } catch (e: any) {
      return { success: false, error: e?.message || String(e) };
    }
  }

  @Post('test-drive-multipart')
  async testDriveMultipart(): Promise<any> {
    try {
      const drive = (this.driveService as any).drive;
      const folderId = await this.driveService.ensureFolder('debug-multipart');
      const name = `debug-${Date.now()}.txt`;
      const start = Date.now();
      const res = await drive.files.create({
        requestBody: { name, parents: [folderId] },
        media: { mimeType: 'text/plain', body: 'hello!' },
        fields: 'id, webViewLink',
        supportsAllDrives: true,
      });
      return {
        success: true,
        file: res.data,
        elapsedMs: Date.now() - start,
      };
    } catch (error: any) {
      return {
        success: false,
        error: error.message,
        details: error.stack,
      };
    }
  }
}
