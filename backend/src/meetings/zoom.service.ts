import { Injectable, Logger } from '@nestjs/common';
import axios from 'axios';
import * as qs from 'qs';

@Injectable()
export class ZoomService {
  private readonly logger = new Logger(ZoomService.name);
  private zoomBaseUrl = 'https://api.zoom.us/v2';
  private accessToken: string | null = null;
  private accessTokenExpiresAt: number | null = null;

  private isTokenValid(): boolean {
    return Boolean(this.accessToken && this.accessTokenExpiresAt && Date.now() < this.accessTokenExpiresAt);
  }

  private async generateAccessToken(): Promise<string> {
    if (this.isTokenValid()) return this.accessToken!;

    const accountId = process.env.ZOOM_ACCOUNT_ID;
    const clientId = process.env.ZOOM_CLIENT_ID;
    const clientSecret = process.env.ZOOM_CLIENT_SECRET;

    const tokenUrl = 'https://zoom.us/oauth/token';

    const auth = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');

    const { data } = await axios.post(
      `${tokenUrl}?grant_type=account_credentials&account_id=${accountId}`,
      null,
      {
        headers: {
          Authorization: `Basic ${auth}`,
        },
      },
    );

    this.accessToken = data.access_token;
    const expiresInSec = Number(data?.expires_in) || 3600;
    const safetyWindowMs = 60 * 1000;
    this.accessTokenExpiresAt = Date.now() + Math.max(0, expiresInSec * 1000 - safetyWindowMs);

    // Opcional: setTimeout para invalidar después de 1 hora
    setTimeout(() => {
      this.accessToken = null;
      this.accessTokenExpiresAt = null;
    }, 3500 * 1000);

    if (!this.accessToken) {
      throw new Error('Zoom access token could not be generated');
    }

    return this.accessToken;
  }

  async ensureFreshToken(): Promise<void> {
    if (!this.isTokenValid()) {
      await this.generateAccessToken();
    }
  }

  // Exponer token para integraciones internas (descarga de grabaciones)
  async getAccessToken(): Promise<string> {
    return this.generateAccessToken();
  }

  async createMeeting(hostEmail: string, topic: string, startTime: string): Promise<any> {
    const token = await this.generateAccessToken();

    const body = {
      topic,
      type: 2, // Scheduled meeting
      start_time: startTime,
      duration: 60,
      timezone: 'America/Lima',
      settings: {
        host_video: true,
        participant_video: false,
        join_before_host: false,
        mute_upon_entry: true,
        approval_type: 0,
      },
    };

    try {
      const response = await axios.post(
        `${this.zoomBaseUrl}/users/${hostEmail}/meetings`,
        body,
        {
          headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json',
          },
        },
      );

      return response.data; // Incluye id, join_url, etc.
    } catch (error) {
      this.logger.error('Error al crear reunión Zoom', error?.response?.data || error);
      throw new Error('Zoom meeting creation failed');
    }
  }
}
