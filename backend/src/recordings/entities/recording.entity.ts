export class Recording {
  id: string; // UUID as string
  meetingId: string; // UUID as string
  fileUrl: string;
  driveUrl: string;
  uploaded: boolean;
  createdAt: Date;
}