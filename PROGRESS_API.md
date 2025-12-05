# Watch Progress API

This document describes the watch progress tracking functionality added to the tvhomerun-backend API.

## Overview

The API now supports tracking playback progress (resume position and watched status) for episodes. Progress is stored locally in the SQLite database and optionally relayed to HDHomeRun devices (experimental).

## Endpoints

### Update Episode Progress

Updates the playback position and watched status for an episode.

**Endpoint:** `PUT /api/episodes/:id/progress`

**Request Body:**
```json
{
  "position": 1234,  // Resume position in seconds
  "watched": 0       // Watched status: 0 = not watched, 1 = watched
}
```

**Example Request:**
```bash
curl -X PUT http://localhost:3000/api/episodes/239/progress \
  -H "Content-Type: application/json" \
  -d '{"position": 1234, "watched": 0}'
```

**Success Response (200 OK):**
```json
{
  "success": true,
  "episode": {
    "id": 239,
    "title": "The Times That Try Men's Souls",
    "resume_position": 1234,
    "resume_minutes": 21,
    "watched": 0,
    "duration": 7200,
    "duration_minutes": 120,
    "play_url": "http://localhost:3000/api/stream/239/playlist.m3u8",
    ...
  }
}
```

**Error Responses:**
- `400 Bad Request` - Missing or invalid position/watched fields
- `404 Not Found` - Episode not found
- `500 Internal Server Error` - Database error

### Get Episode Details

Retrieves detailed information about a specific episode, including progress.

**Endpoint:** `GET /api/episodes/:id`

**Example Request:**
```bash
curl http://localhost:3000/api/episodes/239
```

**Success Response (200 OK):**
```json
{
  "episode": {
    "id": 239,
    "title": "The Times That Try Men's Souls",
    "episode_title": "The Times That Try Men's Souls",
    "resume_position": 1234,
    "resume_minutes": 21,
    "watched": 0,
    "duration": 7200,
    "duration_minutes": 120,
    "series_title": "The American Revolution",
    ...
  }
}
```

## Data Model

Progress is stored in the `episodes` table with two fields:

- `resume_position` (INTEGER) - Resume position in seconds (0 = not started)
- `watched` (BOOLEAN) - Whether the episode has been fully watched (0 or 1)

The database also stores:
- `updated_at` timestamp - Updated whenever progress changes
- `cmd_url` - HDHomeRun command URL for the episode

## HDHomeRun Integration

### Current Behavior

**FROM HDHomeRun (Sync):**
- During discovery, the API reads the `Resume` field from HDHomeRun's episode JSON
- Resume position is synced to the local database
- Special value `4294967295` (max uint32) indicates no resume point

**TO HDHomeRun (Relay - Experimental):**
- When progress is updated via the API, it attempts to relay to HDHomeRun's `CmdURL` endpoint
- This is done as a best-effort POST request with parameters:
  - `position` - Resume position in seconds
  - `watched` - Watched status (0 or 1)
  - `resume` - Resume position (duplicate for compatibility)
- If the relay fails (400 status), it's logged but doesn't affect the API response
- The HDHomeRun progress API is not officially documented, so relay may not work

### Source of Truth

**Local Database** is the source of truth for progress tracking:
- Progress updates are always saved to the local database
- API responses always reflect the local database state
- HDHomeRun relay is optional and doesn't affect API functionality

**Future Sync:**
- During hourly discovery, HDHomeRun's Resume values are synced to local database
- This allows progress made on other HDHomeRun clients to be reflected in the API
- Local progress updates between syncs are preserved

## Implementation Details

### Database Layer (`src/database.js`)

**New Method:**
```javascript
async updateEpisodeProgress(episodeId, position, watched)
```
- Updates `resume_position` and `watched` fields
- Updates `updated_at` timestamp
- Returns the updated episode object

### API Layer (`src/server.js`)

**New Method:**
```javascript
async relayProgressToHDHomeRun(cmdUrl, position, watched)
```
- Attempts to POST progress to HDHomeRun's CmdURL
- Uses form-encoded data (`application/x-www-form-urlencoded`)
- 5-second timeout
- Logs failures but doesn't throw errors

**Endpoint Logic:**
1. Validate input parameters
2. Check if episode exists
3. Update progress in local database
4. Attempt HDHomeRun relay (background, non-blocking)
5. Return success response with updated episode

## Usage Examples

### Updating Progress Every 30 Seconds

```javascript
// Client-side JavaScript
let currentPosition = 0;
const episodeId = 239;

// Update progress every 30 seconds during playback
setInterval(() => {
  if (!player.paused) {
    currentPosition = Math.floor(player.currentTime);

    fetch(`http://localhost:3000/api/episodes/${episodeId}/progress`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        position: currentPosition,
        watched: 0
      })
    });
  }
}, 30000);
```

### Marking as Watched on Completion

```javascript
// When video ends or user reaches 95% of duration
player.on('ended', () => {
  fetch(`http://localhost:3000/api/episodes/${episodeId}/progress`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      position: player.duration,
      watched: 1
    })
  });
});
```

### Resuming Playback

```javascript
// On page load, get episode details to resume
fetch(`http://localhost:3000/api/episodes/${episodeId}`)
  .then(res => res.json())
  .then(data => {
    const episode = data.episode;

    if (episode.resume_position > 0 && !episode.watched) {
      // Ask user if they want to resume
      if (confirm(`Resume from ${formatTime(episode.resume_position)}?`)) {
        player.currentTime = episode.resume_position;
      }
    }
  });
```

## Testing

### Manual Testing

Test progress update:
```bash
curl -X PUT http://localhost:3000/api/episodes/239/progress \
  -H "Content-Type: application/json" \
  -d '{"position": 1234, "watched": 0}'
```

Verify update:
```bash
curl http://localhost:3000/api/episodes/239 | grep -E "resume_position|watched"
```

Test marking as watched:
```bash
curl -X PUT http://localhost:3000/api/episodes/239/progress \
  -H "Content-Type: application/json" \
  -d '{"position": 7200, "watched": 1}'
```

### Verbose Logging

To see HDHomeRun relay attempts:
```bash
npm run dev
```

Debug output will show:
```
[DEBUG] Updated progress for episode 239: position=3600s, watched=0
[DEBUG] Attempting to relay progress to HDHomeRun: http://192.168.1.100/recorded/cmd?id=...
[DEBUG] HDHomeRun progress relay failed (expected): Request failed with status code 400
```

## Future Enhancements

1. **Bulk Progress Update:** Add endpoint to update progress for multiple episodes
2. **Progress Statistics:** Add endpoint to get user's watch statistics
3. **HDHomeRun API Discovery:** Monitor for official HDHomeRun progress API documentation
4. **Bidirectional Sync:** Detect and merge progress changes from HDHomeRun during sync
5. **Progress History:** Track watch history over time
6. **Resume Point Hints:** Automatically set resume points at chapter boundaries
