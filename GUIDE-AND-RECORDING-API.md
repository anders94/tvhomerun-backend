# Program Guide and Recording Rules API

This document describes the newly implemented program guide and recording rules management features.

## Overview

The system provides comprehensive program guide (EPG) browsing and DVR recording management through:
- **Intelligent caching**: Guide data is cached locally with 15-minute freshness checks
- **Cloud-based recording rules**: Rules managed via HDHomeRun cloud API with automatic device synchronization
- **Historical data retention**: Guide data accumulates over time in the database
- **Recent data APIs**: Endpoints return only recent/upcoming programs (not full historical cache)

## Database Schema

All schema definitions are in `schema.sql`. The guide and recording tables use `IF NOT EXISTS` for safe migration on existing databases.

**Automatic Migration**: The app automatically creates guide tables on startup if they don't exist. No manual migration is required - just start the app and the database will be upgraded automatically.

### Guide and Recording Tables

**guide_channels** - Channel information cache
- guide_number, guide_name, affiliate, image_url
- Unique constraint on guide_number
- Automatically refreshed from cloud API

**guide_programs** - Program listings cache
- series_id, title, episode info, timing, synopsis
- Foreign key to guide_channels
- Programs older than current time kept for history
- APIs filter to show only recent/upcoming content

**recording_rules** - Recording rules cache
- recording_rule_id, series_id, filters, priorities
- Synchronized from cloud API
- Updated after every rule mutation

### Views

**current_guide** - Shows current and upcoming programs (next 24 hours)

**recording_rules_detail** - Recording rules with episode counts and statistics

## API Endpoints

### Program Guide Endpoints

#### `GET /api/guide`
Get program guide for all channels (next 24 hours)

**Query Parameters:**
- `forceRefresh` (boolean) - Force refresh from cloud API

**Response:**
```json
{
  "guide": [
    {
      "GuideNumber": "2.1",
      "GuideName": "WGBHDT",
      "Affiliate": "PBS",
      "ImageURL": "...",
      "Guide": [
        {
          "SeriesID": "C184159ENJENN",
          "Title": "Nova",
          "EpisodeNumber": "S48E15",
          "EpisodeTitle": "Dinosaur Apocalypse",
          "Synopsis": "...",
          "StartTime": 1764950400,
          "EndTime": 1764952200,
          "Duration": 1800,
          "ImageURL": "...",
          "Filter": ["Science"]
        }
      ]
    }
  ],
  "channels": 45,
  "timestamp": "2025-12-05T16:00:00Z"
}
```

**Caching Strategy:**
- Data cached for 15 minutes
- Automatic refresh if stale
- Background refresh doesn't block request
- Historical data retained in database

#### `GET /api/guide/search`
Search programs across all channels

**Query Parameters:**
- `q` or `query` (string, required) - Search term
- `channel` (string, optional) - Filter by channel number
- `limit` (number, optional, default: 50) - Max results

**Example:** `/api/guide/search?q=nova&channel=2.1`

**Response:**
```json
{
  "results": [
    {
      "guide_number": "2.1",
      "guide_name": "WGBHDT",
      "series_id": "C184159ENJENN",
      "title": "Nova",
      "episode_title": "Dinosaur Apocalypse",
      "start_time": 1764950400,
      "end_time": 1764952200
    }
  ],
  "count": 1,
  "query": "nova",
  "filters": { "channel": "2.1", "limit": 50 }
}
```

#### `GET /api/guide/now`
Get what's currently playing on all channels

**Response:**
```json
{
  "programs": [
    {
      "guide_number": "2.1",
      "guide_name": "WGBHDT",
      "series_id": "C184159ENJENN",
      "title": "Nova",
      "episode_number": "S48E15",
      "start_time": 1764950400,
      "end_time": 1764952200
    }
  ],
  "count": 45,
  "timestamp": "2025-12-05T16:30:00Z"
}
```

### Recording Rules Endpoints

#### `GET /api/recording-rules`
List all recording rules (always fetches fresh from cloud)

**Response:**
```json
{
  "rules": [
    {
      "RecordingRuleID": "7897331",
      "SeriesID": "C18361200EN88S3",
      "Title": "All Creatures Great and Small",
      "Synopsis": "...",
      "ImageURL": "...",
      "ChannelOnly": "2.1",
      "RecentOnly": 1,
      "Priority": 10,
      "StartPadding": 30,
      "EndPadding": 30
    }
  ],
  "count": 1,
  "timestamp": "2025-12-05T16:00:00Z"
}
```

**Note:** Fetches from cloud API on every request to ensure freshness

#### `POST /api/recording-rules`
Create or update a recording rule

**Request Body:**
```json
{
  "SeriesID": "C184159ENJENN",
  "ChannelOnly": "2.1",
  "RecentOnly": true,
  "StartPadding": 60,
  "EndPadding": 120
}
```

**Parameters:**
- `SeriesID` (string, required) - Series identifier from guide
- `ChannelOnly` (string, optional) - Pipe-separated channel numbers ("2.1|4.1")
- `TeamOnly` (string, optional) - Pipe-separated team names (sports)
- `RecentOnly` (boolean, optional) - Only new episodes
- `AfterOriginalAirdateOnly` (number, optional) - Unix timestamp threshold
- `DateTimeOnly` (number, optional) - Unix timestamp for one-time recording
- `StartPadding` (number, optional) - Seconds before (default: 30)
- `EndPadding` (number, optional) - Seconds after (default: 30)

**Response:**
```json
{
  "success": true,
  "message": "Recording rule created",
  "params": { ... }
}
```

**Side Effects:**
1. Cloud API updated with new rule
2. All HDHomeRun devices notified to sync
3. Local cache updated

#### `DELETE /api/recording-rules/:id`
Delete a recording rule

**Example:** `DELETE /api/recording-rules/7897331`

**Response:**
```json
{
  "success": true,
  "message": "Recording rule deleted",
  "recordingRuleId": "7897331"
}
```

**Side Effects:**
1. Cloud API updated (rule deleted)
2. All devices notified to sync
3. Local cache updated

#### `PUT /api/recording-rules/:id/priority`
Change recording rule priority

**Request Body:**
```json
{
  "afterRecordingRuleId": "7939758"
}
```

Use `"0"` for highest priority

**Response:**
```json
{
  "success": true,
  "message": "Recording rule priority updated",
  "recordingRuleId": "7897331",
  "afterRecordingRuleId": "7939758"
}
```

#### `GET /api/recording-rules/:id`
Get specific recording rule details

**Example:** `GET /api/recording-rules/7897331`

#### `GET /api/series/:seriesId/recording-rule`
Check if a series has active recording rules

**Example:** `GET /api/series/C184159ENJENN/recording-rule`

**Response:**
```json
{
  "seriesId": "C184159ENJENN",
  "hasRecordingRule": true,
  "rules": [
    {
      "recording_rule_id": "7897331",
      "series_id": "C184159ENJENN",
      "channel_only": "2.1",
      "recent_only": 1,
      "priority": 10
    }
  ]
}
```

## Architecture

### Guide Data Flow

```
User Request → Check Cache Age
             ↓
         Is Fresh? (< 15 min)
        /              \
      Yes              No
       |                |
    Return         Fetch from Cloud API
    Cached    →    Update Cache
    Data      ←    Return Fresh Data
```

### Recording Rules Flow

```
Create/Update/Delete Rule
         ↓
    Cloud API Call
         ↓
    Success?
     ↙    ↘
   Yes     No
    |      └─→ Return Error
    ↓
Sync All Devices (POST /recording_events.post?sync)
    ↓
Update Local Cache
    ↓
Return Success
```

### Device Synchronization

After any recording rule mutation:
1. **Cloud API** is updated first (source of truth)
2. **All devices** receive sync notification via `POST /recording_events.post?sync`
3. **Local cache** is updated for quick lookups
4. **Devices fetch** updated rules from cloud in background

## Implementation Details

### Modules

**src/guide.js** - Guide data management
- `getGuide()` - Get cached guide with auto-refresh
- `searchGuide()` - Search cached programs
- `getCurrentPrograms()` - What's on now
- `refreshGuideCache()` - Fetch from cloud API

**src/recording-rules.js** - Recording rules management
- `listRules()` - Fetch from cloud and update cache
- `createRule()` - Create rule + sync devices
- `deleteRule()` - Delete rule + sync devices
- `changePriority()` - Update priority + sync devices
- `syncAllDevices()` - Notify all devices to refresh

### Configuration

**Guide Cache Duration:** 15 minutes (configurable in src/guide.js)
**Guide Window:** 24 hours forward by default
**Historical Data:** Never purged (accumulates indefinitely)

### Error Handling

- Missing DeviceAuth: Returns clear error message
- Cloud API failure: Returns 500 with details
- Device sync failure: Logs warning but doesn't fail request
- Validation errors: Returns 400 with field requirements

## Usage Examples

### Browse Tonight's Programs

```bash
curl http://localhost:3000/api/guide
```

### Search for a Show

```bash
curl "http://localhost:3000/api/guide/search?q=nova"
```

### Schedule Series Recording

```bash
curl -X POST http://localhost:3000/api/recording-rules \
  -H "Content-Type: application/json" \
  -d '{
    "SeriesID": "C184159ENJENN",
    "RecentOnly": true,
    "ChannelOnly": "2.1"
  }'
```

### List Recording Rules

```bash
curl http://localhost:3000/api/recording-rules
```

### Delete Recording Rule

```bash
curl -X DELETE http://localhost:3000/api/recording-rules/7897331
```

## Integration with Existing Features

### Recorded Episodes
- Guide's SeriesID links to existing recorded episodes
- Can check which shows already have recordings

### Discovery Process
- Independent of guide caching
- Guide data fetched on-demand when accessed

### HLS Streaming
- No impact on streaming functionality
- Recording rules don't affect playback

## Performance Considerations

### Guide Data
- **Cache hit:** <1ms (database query)
- **Cache miss:** ~2-3s (cloud API + database update)
- **Database growth:** ~1MB per week of guide data
- **Recommendation:** Periodic cleanup of very old programs (>90 days)

### Recording Rules
- **List rules:** ~1-2s (cloud API + cache update)
- **Create/delete:** ~2-3s (cloud API + device sync + cache update)
- **Device sync:** Parallel requests, ~500ms per device
- **Cache overhead:** Minimal (~1KB per rule)

## Security

- **DeviceAuth required:** All operations require valid device auth token
- **No user authentication:** Uses HDHomeRun's cloud authentication
- **Local network:** Device sync limited to local network devices
- **No secrets stored:** DeviceAuth obtained from devices on-demand

## Future Enhancements

Potential improvements:
- Scheduled guide refresh (e.g., nightly)
- Program recommendations based on recording history
- Conflict detection when scheduling recordings
- Email/push notifications for recording failures
- Guide data export (XMLTV format)
