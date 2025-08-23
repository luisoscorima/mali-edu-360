# Manual Retry System for Zoom Recordings

This document describes how to use the manual retry system for reprocessing Zoom recordings that may have failed or missed webhook processing.

## Endpoint

```
POST /admin/recordings/retry
```

## Request Format

The request accepts exactly one selector and optional flags:

### Selectors (Choose One)

- `zoomRecordingId: string` - Process specific recording by Zoom recording ID
- `meetingId: string` - Process recordings for internal meeting UUID  
- `zoomMeetingId: string` - Process recordings for Zoom meeting ID
- `from: string, to: string` - Process recordings in time range (ISO8601 format)

### Optional Flags

- `republish: boolean` - Skip download/upload if Drive file exists, only republish to Moodle
- `forceRedownload: boolean` - Force re-download even if Drive file exists
- `forceRepost: boolean` - Force new Moodle post even if one exists
- `overrideCourseIdMoodle: number` - Override course resolution with specific course ID
- `dryRun: boolean` - Preview what would be done without executing
- `limit: number` - Max items to process (default: 5, recommended for time ranges)

## Response Format

Returns an array of results:

```json
[
  {
    "selector": {"zoomRecordingId": "abc123"},
    "mode": "republish|full|skipped", 
    "status": "ok|failed|skipped",
    "reason": "detailed reason",
    "meetingId": "uuid",
    "zoomMeetingId": "zoom-id",
    "courseIdMoodle": 13,
    "driveUrl": "https://drive.google.com/...",
    "moodlePostId": 123,
    "integrity": {
      "localMd5": "...",
      "driveMd5": "...", 
      "sizeBytes": 1234567
    }
  }
]
```

## Test Cases

### 1. Republish Only (Recording exists in Drive)

```bash
curl -X POST http://localhost:3000/admin/recordings/retry \
  -H "Content-Type: application/json" \
  -d '{
    "zoomRecordingId": "your-zoom-recording-id",
    "republish": true
  }'
```

**Expected:** Skip download/upload, only republish to Moodle forum

### 2. Force Full Reprocess

```bash
curl -X POST http://localhost:3000/admin/recordings/retry \
  -H "Content-Type: application/json" \
  -d '{
    "zoomRecordingId": "your-zoom-recording-id", 
    "forceRedownload": true
  }'
```

**Expected:** Full pipeline - download from Zoom, upload to Drive, post to Moodle

### 3. Process by Meeting ID

```bash
curl -X POST http://localhost:3000/admin/recordings/retry \
  -H "Content-Type: application/json" \
  -d '{
    "zoomMeetingId": "96188779212"
  }'
```

**Expected:** Process all recordings for that meeting

### 4. Time Range Processing

```bash
curl -X POST http://localhost:3000/admin/recordings/retry \
  -H "Content-Type: application/json" \
  -d '{
    "from": "2025-08-18T00:00:00Z",
    "to": "2025-08-18T23:59:59Z",
    "limit": 3
  }'
```

**Expected:** Process up to 3 recordings from that day

### 5. Override Course Assignment

```bash
curl -X POST http://localhost:3000/admin/recordings/retry \
  -H "Content-Type: application/json" \
  -d '{
    "zoomRecordingId": "your-zoom-recording-id",
    "overrideCourseIdMoodle": 13
  }'
```

**Expected:** Assign recording to course ID 13 regardless of topic resolution

### 6. Dry Run Preview

```bash
curl -X POST http://localhost:3000/admin/recordings/retry \
  -H "Content-Type: application/json" \
  -d '{
    "zoomRecordingId": "your-zoom-recording-id",
    "dryRun": true
  }'
```

**Expected:** Return what would be done without actually executing

## Status Meanings

- **ok**: Successfully processed
- **skipped**: Already completed or dry run
- **failed**: Error occurred during processing

## Common Reasons

- `already-completed`: Recording already processed and no force flags set
- `no-course-resolved`: Could not determine Moodle course from topic
- `no-drive-url-found`: Republish requested but no Drive URL exists
- `already-in-progress`: Another retry is currently processing this recording
- `dry-run`: Preview mode, no changes made
- `full-mode-not-implemented`: Full reprocessing requires additional Zoom API integration

## Logs

Look for these log patterns:

- `retry:start` - Request initiated
- `retry:resolve` - Found target recordings  
- `retry:mode=republish|full` - Processing mode determined
- `retry:done` - Successfully completed
- `retry:fail` - Error occurred

## Notes

- Maintains idempotency - won't duplicate unless forced
- Uses same LTI topic resolution as webhook processing
- Respects download restrictions and file validations
- Sequential processing to avoid timeouts
- In-memory concurrency guards prevent duplicate processing
- Does not affect license management (LTI meetings don't use licenses)

## Limitations

- Full mode (download from Zoom) requires additional API integration
- Currently supports republish mode fully
- Time range queries limited by database records
- In-memory guards don't persist across restarts
