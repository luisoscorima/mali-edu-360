import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

export interface ZoomRecordingFile {
  id: string;
  meeting_id: string;
  recording_start: string;
  recording_end: string;
  file_type: string;
  file_extension: string;
  file_size: number;
  play_url: string;
  download_url: string;
  status: string;
  recording_type: string;
}

export interface ZoomMeetingRecording {
  uuid: string;
  id: number;
  account_id: string;
  host_id: string;
  topic: string;
  type: number;
  start_time: string;
  duration: number;
  share_url: string;
  total_size: number;
  recording_count: number;
  recording_files: ZoomRecordingFile[];
}

export interface ZoomRecordingsResponse {
  from: string;
  to: string;
  page_count: number;
  page_number: number;
  page_size: number;
  total_records: number;
  next_page_token?: string;
  meetings: ZoomMeetingRecording[];
}

@Injectable()
export class ZoomRecordingsService {
  private readonly logger = new Logger(ZoomRecordingsService.name);
  
  constructor(private readonly configService: ConfigService) {}

  async getAccessToken(): Promise<string> {
    const accountId = this.configService.get<string>('ZOOM_ACCOUNT_ID');
    const clientId = this.configService.get<string>('ZOOM_CLIENT_ID');
    const clientSecret = this.configService.get<string>('ZOOM_CLIENT_SECRET');

    this.logger.debug(`Getting access token with accountId: ${accountId}, clientId: ${clientId}`);

    const auth = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');

    const response = await fetch('https://zoom.us/oauth/token', {
      method: 'POST',
      headers: {
        'Authorization': `Basic ${auth}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: `grant_type=account_credentials&account_id=${accountId}`,
    });

    if (!response.ok) {
      const error = await response.text();
      this.logger.error(`Failed to get Zoom access token: ${response.status} ${error}`);
      throw new Error(`Failed to get Zoom access token: ${response.statusText}`);
    }

    const data = await response.json();
    this.logger.debug(`Successfully obtained access token`);
    return data.access_token;
  }

  async listRecordings(params: {
    userId?: string;
    from: string; // YYYY-MM-DD
    to: string;   // YYYY-MM-DD
    pageSize?: number;
    nextPageToken?: string;
    mc?: string; // meeting_id para buscar grabación específica
    trash?: boolean;
  }): Promise<ZoomRecordingsResponse> {
    // Si no se especifica userId, obtener grabaciones de todos los usuarios
    if (!params.userId) {
      return this.listAllUsersRecordings(params);
    }

    const accessToken = await this.getAccessToken();
    const userId = params.userId;
    
    const searchParams = new URLSearchParams({
      from: params.from,
      to: params.to,
      page_size: (params.pageSize || 300).toString(),
    });

    if (params.nextPageToken) {
      searchParams.append('next_page_token', params.nextPageToken);
    }
    if (params.mc) {
      searchParams.append('mc', params.mc);
    }
    if (params.trash) {
      searchParams.append('trash', 'true');
    }

    const url = `https://api.zoom.us/v2/users/${userId}/recordings?${searchParams}`;
    
    this.logger.log(`Fetching recordings from: ${url}`);

    const response = await fetch(url, {
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
    });

    if (!response.ok) {
      const error = await response.text();
      this.logger.error(`Failed to fetch recordings: ${response.status} ${error}`);
      throw new Error(`Failed to fetch recordings: ${response.status} ${error}`);
    }

    const result = await response.json();
    this.logger.log(`Successfully fetched ${result.meetings?.length || 0} meetings for user ${userId}`);
    return result;
  }

  async listAllUsersRecordings(params: {
    from: string;
    to: string;
    pageSize?: number;
    nextPageToken?: string;
    mc?: string;
    trash?: boolean;
  }): Promise<ZoomRecordingsResponse> {
    const accessToken = await this.getAccessToken();
    
    // Primero obtener todos los usuarios
    const usersResponse = await fetch('https://api.zoom.us/v2/users?page_size=100', {
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
    });

    if (!usersResponse.ok) {
      throw new Error(`Failed to get users: ${usersResponse.status}`);
    }

    const usersData = await usersResponse.json();
    this.logger.log(`Found ${usersData.users?.length || 0} users to search recordings`);
    
    // Buscar grabaciones para cada usuario y consolidar
    const allMeetings: any[] = [];
    let totalRecords = 0;
    
    for (const user of usersData.users || []) {
      try {
        const userRecordings = await this.listRecordings({
          ...params,
          userId: user.id
        });
        
        if (userRecordings.meetings) {
          allMeetings.push(...userRecordings.meetings);
          totalRecords += userRecordings.total_records || 0;
        }
      } catch (error) {
        this.logger.warn(`Failed to get recordings for user ${user.email} (${user.id}): ${error.message}`);
        // Continuar con otros usuarios
      }
    }

    // Ordenar por fecha de inicio (más recientes primero)
    allMeetings.sort((a, b) => new Date(b.start_time).getTime() - new Date(a.start_time).getTime());

    this.logger.log(`Found total ${allMeetings.length} recordings across all users`);

    return {
      from: params.from,
      to: params.to,
      meetings: allMeetings,
      total_records: totalRecords,
      page_count: Math.ceil(allMeetings.length / (params.pageSize || 30)),
      page_number: 1,
      page_size: params.pageSize || 30,
      next_page_token: undefined
    };
  }

  async getAllRecordings(params: {
    userId?: string;
    from: string;
    to: string;
    maxPages?: number;
  }): Promise<ZoomMeetingRecording[]> {
    const allRecordings: ZoomMeetingRecording[] = [];
    let nextPageToken: string | undefined;
    let pageCount = 0;
    const maxPages = params.maxPages || 50;

    do {
      this.logger.log(`Fetching page ${pageCount + 1}...`);
      
      const response = await this.listRecordings({
        userId: params.userId,
        from: params.from,
        to: params.to,
        nextPageToken,
        pageSize: 300,
      });

      allRecordings.push(...response.meetings);
      nextPageToken = response.next_page_token;
      pageCount++;

      this.logger.log(`Page ${pageCount}: found ${response.meetings.length} meetings (total: ${allRecordings.length})`);

      // Evitar loops infinitos
      if (pageCount >= maxPages) {
        this.logger.warn(`Reached maximum pages limit (${maxPages}), stopping`);
        break;
      }

    } while (nextPageToken);

    return allRecordings;
  }

  async getRecordingById(meetingId: string): Promise<ZoomMeetingRecording | null> {
    try {
      const wanted = String(meetingId).replace(/\s+/g, '');

      // Rango últimos 6 meses
      const to = new Date();
      const from = new Date();
      from.setMonth(from.getMonth() - 6);
      const fromStr = from.toISOString().split('T')[0];
      const toStr = to.toISOString().split('T')[0];

      // Obtener usuarios y consultar por mc (meeting id) por cada usuario
      const accessToken = await this.getAccessToken();
      const usersResponse = await fetch('https://api.zoom.us/v2/users?page_size=100', {
        headers: {
          'Authorization': `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
        },
      });
      if (!usersResponse.ok) {
        throw new Error(`Failed to get users: ${usersResponse.status}`);
      }
      const usersData = await usersResponse.json();

      for (const user of usersData.users || []) {
        try {
          const resp = await this.listRecordings({
            userId: user.id,
            from: fromStr,
            to: toStr,
            pageSize: 50,
            mc: wanted,
          });
          const match = (resp.meetings || []).find((m: any) => String(m.id) === wanted || String(m.uuid) === wanted);
          if (match) return match as ZoomMeetingRecording;
        } catch (e) {
          this.logger.warn(`getRecordingById: failed for user ${user.email} (${user.id}): ${String((e as any)?.message || e)}`);
        }
      }

      // Fallback: búsqueda amplia (por si mc no responde)
      const wide = await this.listAllUsersRecordings({ from: fromStr, to: toStr, pageSize: 300 });
      const found = wide.meetings.find((m: any) => String(m.id) === wanted) || wide.meetings.find((m: any) => String(m.uuid) === wanted);
      return (found as ZoomMeetingRecording) || null;
    } catch (error) {
      this.logger.error(`Error fetching recording ${meetingId}:`, error);
      return null;
    }
  }
}
