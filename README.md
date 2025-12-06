# TVHomeRun Backend

This is a backend server for TVHomeRun apps including [TVHomeRun tvOS](https://github.com/anders94/tvhomerun-tvos) for AppleTV, [TVHomeRun iOS](https://github.com/anders94/tvhomerun-ios) for iPhone or iPad and [TVHomeRun Web](https://github.com/anders94/tvhomerun-web). It is a Node.js API server for [HDHomeRun devices](https://www.silicondust.com/hdhomerun/) that automatically discovers devices on your network and provides REST endpoints and automatic HLS conversions for accessing DVR content. The server runs periodic discovery and maintains a local SQLite database of all devices, shows, and episodes.

## Features

- **Automatic Device Discovery**: Multi-method discovery using UDP broadcast, HTTP fallback, and network scanning
- **DVR Content Management**: Access recorded shows, episodes, and metadata from HDHomeRun DVR devices
- **Program Guide**: Browse EPG data with intelligent 15-minute caching, search programs, and see what's on now
- **Recording Rules Management**: Create, delete, and prioritize series recordings via HDHomeRun cloud API
- **REST API**: Clean JSON endpoints for integration with web apps, mobile apps, or home automation systems
- **HLS Proxy**: Automatically creates HLS versions of episodes supporting native playback on Apple devices
- **Playback Progress Sync**: Track and sync playback position between local database and HDHomeRun devices
- **Recording Deletion**: Delete recordings from devices with automatic cache and database cleanup
- **Periodic Sync**: Automatic hourly discovery to keep content up-to-date
- **SQLite Database**: Local storage for offline browsing and fast queries
- **Search & Filter**: Find shows by title, category, or other criteria
- **CORS Enabled**: Ready for browser-based applications
- **Command Line Tools**: Manage progress and compare sync status between device and database

## Prerequisites

- Node.js (v14 or higher)
- HDHomeRun device(s) on your local network
- HDHomeRun DVR subscription (for DVR features)

## Installation

```bash
# Clone the repository
git clone https://github.com/anders94/tvhomerun-backend.git
cd tvhomerun-backend

# Install dependencies
npm install

# Start the server
npm start
```

The server will start on port 3000 by default and immediately begin discovering devices and syncing content.

## Usage

### Starting the Server

```bash
# Production mode
npm start

# Development mode with verbose logging
npm run dev

# Pre-cache mode (convert all episodes to HLS on discovery)
npm run pre-cache

# Development mode with pre-cache
npm run dev:pre-cache

# Custom port
PORT=8080 npm start
```

### Running Discovery Manually

```bash
# Run the CLI discovery tool
npm run scan
```

### Command Line Tools

```bash
# Manage playback progress (local database)
npm run progress get 123           # Get progress for episode
npm run progress set 123 1800      # Set position to 1800 seconds
npm run progress list --in-progress # List episodes in progress

# Manage device progress (with HDHomeRun sync)
npm run device-progress get 123    # Compare database vs device
npm run device-progress set 123 1800  # Set on both device and database
npm run device-progress sync 123   # Sync database from device

# Compare all episodes
npm run compare-progress                # Compare all episodes
npm run compare-progress --sync-mismatched  # Sync mismatches from device
```

### Command Line Options

- `--verbose` or `-v`: Enable debug logging for discovery and API operations
- `--pre-cache`: Enable bulk HLS conversion of all episodes after discovery (increases storage usage but improves playback startup time)
- `PORT` environment variable: Set server port (default: 3000)

### HLS Streaming

The server supports on-demand HLS transcoding of recordings. By default, episodes are converted to HLS format when first requested for playback. This saves storage space but may have a delay on first playback.

With `--pre-cache` enabled:
- All episodes are converted to HLS after each discovery
- Conversions respect the concurrent transcode limit (2 by default)
- Progress messages are logged during conversion
- On-demand conversions still work for newly requested episodes during bulk conversion
- Ideal for dedicated media servers with ample storage

HLS conversion endpoint: `GET /api/stream/:episodeId/playlist.m3u8`

## API Endpoints

### Server Information

#### Health Check
```bash
curl http://localhost:3000/health
```

Response:
```json
{
  "status": "ok",
  "uptime": 3600,
  "timestamp": "2025-01-18T10:30:00.000Z"
}
```

#### API Information
```bash
curl http://localhost:3000/api/info
```

Response:
```json
{
  "version": "1.0.0",
  "devices": 2,
  "series": 45,
  "episodes": 327,
  "lastDiscovery": "2025-01-18T10:00:00.000Z"
}
```

### Shows/Series

#### Get All Shows
```bash
# Get all shows
curl http://localhost:3000/api/shows

# Search for shows
curl http://localhost:3000/api/shows?search=masterpiece

# Filter by category
curl http://localhost:3000/api/shows?category=series

# Limit results
curl http://localhost:3000/api/shows?limit=10
```

Response:
```json
[
  {
    "id": 1,
    "series_id": "C28817988ENAQAO",
    "title": "All Creatures Great and Small on Masterpiece",
    "category": "series",
    "image_url": "https://...",
    "episode_count": 12,
    "total_duration": 43200,
    "first_recorded": "2024-01-15T20:00:00.000Z",
    "last_recorded": "2024-03-10T20:00:00.000Z",
    "device_name": "HDHomeRun DVR",
    "created_at": "2025-01-01T10:00:00.000Z"
  }
]
```

#### Get Specific Show
```bash
curl http://localhost:3000/api/shows/1
```

Response:
```json
{
  "id": 1,
  "series_id": "C28817988ENAQAO",
  "title": "All Creatures Great and Small on Masterpiece",
  "category": "series",
  "image_url": "https://...",
  "episodes_url": "http://...",
  "episode_count": 12,
  "total_duration": 43200,
  "device_id": "10AA5474",
  "device_name": "HDHomeRun DVR"
}
```

#### Get Episodes for a Show
```bash
# Get all episodes
curl http://localhost:3000/api/shows/1/episodes

# Filter unwatched episodes
curl http://localhost:3000/api/shows/1/episodes?watched=false

# Filter by season
curl http://localhost:3000/api/shows/1/episodes?season=2

# Limit and sort
curl http://localhost:3000/api/shows/1/episodes?limit=5&sort=asc
```

Response:
```json
[
  {
    "id": 42,
    "program_id": "EP054158040004",
    "title": "All Creatures Great and Small on Masterpiece",
    "episode_title": "The Perfect Christmas",
    "episode_number": "S05E07",
    "season_number": 5,
    "episode_num": 7,
    "synopsis": "The Skeldale House family...",
    "category": "series",
    "channel_name": "WGBHDT",
    "channel_number": "2.1",
    "start_time": 1735603200,
    "end_time": 1735606800,
    "duration": 3600,
    "filename": "All Creatures Great and Small on Masterpiece S05E07.mpg",
    "play_url": "http://localhost:3000/api/stream/42/playlist.m3u8",
    "source_url": "http://192.168.1.100:80/...",
    "hls_cache_bytes": 523456789,
    "watched": false,
    "resume_position": 0,
    "created_at": "2025-01-01T10:00:00.000Z"
  }
]
```

### Episodes

#### Get Recent Episodes
```bash
# Get 20 most recent episodes
curl http://localhost:3000/api/episodes/recent

# Custom limit
curl http://localhost:3000/api/episodes/recent?limit=50
```

Response:
```json
[
  {
    "id": 327,
    "series_id": 45,
    "series_title": "PBS News Hour",
    "episode_title": "January 17, 2025",
    "episode_number": "S2025E17",
    "channel_name": "WGBHDT",
    "start_time": 1737147600,
    "duration": 3600,
    "play_url": "http://...",
    "created_at": "2025-01-18T10:00:00.000Z"
  }
]
```

#### Get Specific Episode
```bash
curl http://localhost:3000/api/episodes/123
```

Response:
```json
{
  "id": 123,
  "series_title": "Celebrity Jeopardy!",
  "episode_title": "Quarterfinal #7",
  "episode_number": "S03E07",
  "duration": 3600,
  "resume_position": 1800,
  "watched": false,
  "play_url": "http://localhost:3000/api/stream/123/playlist.m3u8",
  "source_url": "http://192.168.0.37/recorded/play?id=...",
  "hls_cache_bytes": 1234567890
}
```

**Note**: `hls_cache_bytes` shows the disk space in bytes used by the HLS transcoded cache for this episode. Returns 0 if no cache exists. This is calculated directly from the filesystem (equivalent to `du -s hls-cache/{id}`).

#### Update Playback Progress
```bash
curl -X PUT http://localhost:3000/api/episodes/123/progress \
  -H "Content-Type: application/json" \
  -d '{"position": 1800, "watched": false}'
```

Response:
```json
{
  "success": true,
  "episode": {
    "id": 123,
    "resume_position": 1800,
    "watched": false
  },
  "deviceSync": {
    "attempted": true,
    "success": true,
    "error": null
  }
}
```

**Note**: Progress updates are synced to both the local database and the HDHomeRun device. If device sync fails, the local database is still updated and a warning is logged.

#### Delete Episode
```bash
# Delete without allowing re-record
curl -X DELETE http://localhost:3000/api/episodes/123

# Delete and allow re-recording
curl -X DELETE "http://localhost:3000/api/episodes/123?rerecord=true"
```

Response:
```json
{
  "success": true,
  "message": "Episode deleted successfully",
  "episode": {
    "id": 123,
    "series_title": "Celebrity Jeopardy!",
    "episode_title": "Quarterfinal #7"
  },
  "deviceDeletion": {
    "success": true,
    "status": 200
  },
  "hlsDeletion": {
    "attempted": true,
    "success": true
  }
}
```

**Deletion Workflow**:
1. Recording is deleted from HDHomeRun device (fails fast if this fails)
2. HLS cache directory is removed (`hls-cache/{episodeId}/`)
3. Episode is removed from local database (triggers update series statistics)

**Query Parameters**:
- `rerecord=false` (default): Prevents the program from being recorded again
- `rerecord=true`: Allows the same program to be recorded in future airings

### Discovery

#### Trigger Manual Discovery
```bash
curl -X POST http://localhost:3000/api/discover
```

Response:
```json
{
  "message": "Discovery started",
  "timestamp": "2025-01-18T10:30:00.000Z"
}
```

Note: Discovery runs in the background. Check `/api/info` for completion status.

### Program Guide

#### Get Program Guide
```bash
# Get next 24 hours of programming
curl http://localhost:3000/api/guide

# Force refresh from cloud API
curl "http://localhost:3000/api/guide?forceRefresh=true"
```

Response:
```json
{
  "guide": [
    {
      "GuideNumber": "2.1",
      "GuideName": "WGBHDT",
      "Affiliate": "PBS",
      "ImageURL": "https://img.hdhomerun.com/channels/US28055.png",
      "Guide": [
        {
          "SeriesID": "C185481ENLBRX",
          "Title": "Nature",
          "EpisodeNumber": "S42E12",
          "EpisodeTitle": "Saving the Animals of Ukraine",
          "Synopsis": "Documentary about rescuing animals during the war in Ukraine.",
          "StartTime": 1764961200,
          "EndTime": 1764966600,
          "Duration": 5400,
          "OriginalAirdate": 1715731200,
          "ImageURL": "https://img.hdhomerun.com/titles/C185481ENLBRX.jpg",
          "Filter": ["Documentary"]
        }
      ]
    }
  ],
  "channels": 45,
  "timestamp": "2025-12-05T17:30:00.000Z"
}
```

**Caching**: Guide data is cached for 15 minutes. Historical data is retained in the database, but the API returns only current and upcoming programs.

#### Search Program Guide
```bash
# Search by keyword
curl "http://localhost:3000/api/guide/search?q=nature"

# Search on specific channel
curl "http://localhost:3000/api/guide/search?q=news&channel=2.1"

# Limit results
curl "http://localhost:3000/api/guide/search?q=sports&limit=10"
```

Response:
```json
{
  "results": [
    {
      "guide_number": "2.1",
      "guide_name": "WGBHDT",
      "series_id": "C185481ENLBRX",
      "title": "Nature",
      "episode_number": "S42E12",
      "episode_title": "Saving the Animals of Ukraine",
      "synopsis": "Documentary about rescuing animals...",
      "start_time": 1764961200,
      "end_time": 1764966600,
      "image_url": "https://img.hdhomerun.com/titles/C185481ENLBRX.jpg"
    }
  ],
  "count": 1,
  "query": "nature",
  "filters": {
    "limit": 50
  }
}
```

**Note**: Search looks in title, episode title, and synopsis fields. Results span up to 7 days.

#### What's On Now
```bash
curl http://localhost:3000/api/guide/now
```

Response:
```json
{
  "programs": [
    {
      "guide_number": "2.1",
      "guide_name": "WGBHDT",
      "affiliate": "PBS",
      "series_id": "C7879062ENTLJH",
      "title": "PBS News Hour",
      "episode_number": "S52E114",
      "episode_title": null,
      "start_time": 1764975600,
      "end_time": 1764979200,
      "image_url": "https://img.hdhomerun.com/titles/C7879062ENTLJH.jpg"
    }
  ],
  "count": 45,
  "timestamp": "2025-12-05T18:00:00.000Z"
}
```

**Note**: Returns currently airing programs across all channels at the time of the request.

### Recording Rules

#### List Recording Rules
```bash
curl http://localhost:3000/api/recording-rules
```

Response:
```json
{
  "rules": [
    {
      "RecordingRuleID": "7897331",
      "SeriesID": "C18361200EN88S3",
      "Title": "All Creatures Great and Small on Masterpiece",
      "Synopsis": "James Alfred Wight's series of books...",
      "ImageURL": "https://img.hdhomerun.com/titles/C18361200EN88S3.jpg",
      "ChannelOnly": "2.1",
      "RecentOnly": 1,
      "Priority": 10,
      "StartPadding": 30,
      "EndPadding": 30
    }
  ],
  "count": 1,
  "timestamp": "2025-12-05T17:30:00.000Z"
}
```

**Note**: Fetches fresh data from HDHomeRun cloud API on every request. Rules are automatically synced to local cache.

#### Create Recording Rule
```bash
# Schedule series recording for new episodes only
curl -X POST http://localhost:3000/api/recording-rules \
  -H "Content-Type: application/json" \
  -d '{
    "SeriesID": "C185481ENLBRX",
    "RecentOnly": true,
    "ChannelOnly": "2.1",
    "StartPadding": 60,
    "EndPadding": 120
  }'

# Record all airings
curl -X POST http://localhost:3000/api/recording-rules \
  -H "Content-Type: application/json" \
  -d '{
    "SeriesID": "C184056EN6FJY",
    "ChannelOnly": "4.1|5.1"
  }'
```

Response:
```json
{
  "success": true,
  "message": "Recording rule created",
  "params": {
    "SeriesID": "C185481ENLBRX",
    "RecentOnly": true,
    "ChannelOnly": "2.1",
    "StartPadding": 60,
    "EndPadding": 120
  }
}
```

**Parameters**:
- `SeriesID` (required): Series identifier from program guide
- `ChannelOnly` (optional): Pipe-separated channel numbers (e.g., "2.1|4.1")
- `TeamOnly` (optional): Pipe-separated team names for sports
- `RecentOnly` (boolean): Only record new episodes (default: false)
- `AfterOriginalAirdateOnly` (number): Unix timestamp - only record episodes that originally aired after this date
- `DateTimeOnly` (number): Unix timestamp for one-time recording
- `StartPadding` (number): Seconds to record before start (default: 30)
- `EndPadding` (number): Seconds to record after end (default: 30)

**Side Effects**: Updates cloud API → notifies all HDHomeRun devices → updates local cache

#### Delete Recording Rule
```bash
curl -X DELETE http://localhost:3000/api/recording-rules/7897331
```

Response:
```json
{
  "success": true,
  "message": "Recording rule deleted",
  "recordingRuleId": "7897331"
}
```

**Side Effects**: Deletes from cloud API → notifies all devices → removes from local cache

#### Change Recording Rule Priority
```bash
# Move rule to second position (after rule 7939758)
curl -X PUT http://localhost:3000/api/recording-rules/7897331/priority \
  -H "Content-Type: application/json" \
  -d '{"afterRecordingRuleId": "7939758"}'

# Move to highest priority (first position)
curl -X PUT http://localhost:3000/api/recording-rules/7897331/priority \
  -H "Content-Type: application/json" \
  -d '{"afterRecordingRuleId": "0"}'
```

Response:
```json
{
  "success": true,
  "message": "Recording rule priority updated",
  "recordingRuleId": "7897331",
  "afterRecordingRuleId": "7939758"
}
```

**Note**: Priority determines which recordings are kept when storage space is limited.

#### Get Specific Recording Rule
```bash
curl http://localhost:3000/api/recording-rules/7897331
```

Response:
```json
{
  "recording_rule_id": "7897331",
  "series_id": "C18361200EN88S3",
  "title": "All Creatures Great and Small on Masterpiece",
  "synopsis": "...",
  "image_url": "https://...",
  "channel_only": "2.1",
  "recent_only": 1,
  "priority": 10,
  "start_padding": 30,
  "end_padding": 30
}
```

#### Check Recording Rule for Series
```bash
curl http://localhost:3000/api/series/C185481ENLBRX/recording-rule
```

Response:
```json
{
  "seriesId": "C185481ENLBRX",
  "hasRecordingRule": true,
  "rules": [
    {
      "recording_rule_id": "7920372",
      "series_id": "C185481ENLBRX",
      "title": "Nature",
      "channel_only": null,
      "recent_only": 0,
      "priority": 8
    }
  ]
}
```

**Note**: Returns all recording rules for the specified series. Useful for checking if a show is already scheduled before creating a new rule.

## Configuration

### Environment Variables

- `PORT`: Server port (default: 3000)
- `NODE_ENV`: Environment mode (production/development)

### Database

The SQLite database (`hdhomerun.db`) is automatically created on first run in the project directory. To reset the database, simply delete the file and restart the server.

## Architecture

### Core Components

- **src/server.js**: Express-based REST API server with automatic scheduling
- **src/discovery.js**: Multi-method HDHomeRun device discovery engine
- **src/dvr.js**: DVR content retrieval and management
- **src/database.js**: SQLite persistence layer with CRUD operations
- **src/guide.js**: Program guide manager with intelligent caching
- **src/recording-rules.js**: Recording rules manager via cloud API
- **src/hls-stream.js**: HLS transcoding and streaming manager
- **src/index.js**: CLI discovery tool (accessed via `npm run scan`)

### Discovery Protocol

Implements HDHomeRun's UDP broadcast protocol on port 65001 with proper TLV packet structure and CRC32 validation. Falls back to HTTP discovery service and network scanning for maximum device detection.

See `HDHOMERUN_PROTOCOL.md` for complete protocol documentation.

### Database Schema

Comprehensive SQLite schema with six main tables:

- **devices**: HDHomeRun device tracking with capabilities
- **series**: Show metadata with automatic statistics
- **episodes**: Individual recording details with playback state
- **guide_channels**: Program guide channel information cache
- **guide_programs**: EPG data with historical retention
- **recording_rules**: Recording rules cache synced from cloud

The schema includes views (current_guide, recording_rules_detail), triggers, and indexes for efficient queries and automatic data integrity. Guide tables are automatically created on first run.

## Development

### Running Tests

```bash
# Run discovery test
npm run scan -- --verbose

# Test API endpoints
npm run dev
```

### Project Structure

```
tvhomerun-backend/
├── src/
│   ├── server.js              # Main API server
│   ├── index.js               # CLI discovery tool
│   ├── discovery.js           # Device discovery
│   ├── dvr.js                 # DVR content management
│   ├── database.js            # SQLite operations
│   ├── guide.js               # Program guide manager
│   ├── recording-rules.js     # Recording rules manager
│   ├── hls-stream.js          # HLS transcoding manager
│   ├── progress.js            # Progress management tool (local DB)
│   ├── device-progress.js     # Progress management tool (with device sync)
│   └── compare-progress.js    # Batch progress comparison tool
├── schema.sql                 # Database schema (includes guide tables)
├── CLAUDE.md                  # Development guidelines
├── HDHOMERUN_PROTOCOL.md      # Protocol documentation
├── GUIDE-AND-RECORDING-API.md # Guide and recording API documentation
├── DEVELOPMENT_LOG.md         # Development discoveries and notes
├── package.json
└── README.md
```

### Adding New Endpoints

1. Add route handler in `src/server.js`
2. Create database query methods in `src/database.js` if needed
3. Test with curl or your API client

### Debug Logging

Enable verbose logging to see detailed discovery and API operations:

```bash
npm run dev
```

## Integration Examples

### JavaScript/Node.js

```javascript
const axios = require('axios');

// Get all shows
const shows = await axios.get('http://localhost:3000/api/shows');
console.log(`Found ${shows.data.length} shows`);

// Search for a specific show
const search = await axios.get('http://localhost:3000/api/shows?search=news');

// Get episodes for a show
const episodes = await axios.get(`http://localhost:3000/api/shows/1/episodes`);

// Get program guide
const guide = await axios.get('http://localhost:3000/api/guide');
console.log(`Found ${guide.data.channels} channels`);

// Search for a program
const programs = await axios.get('http://localhost:3000/api/guide/search?q=nature');
console.log(`Found ${programs.data.count} matching programs`);

// Schedule a recording
const rule = await axios.post('http://localhost:3000/api/recording-rules', {
  SeriesID: 'C185481ENLBRX',
  RecentOnly: true,
  ChannelOnly: '2.1'
});
console.log(`Created recording rule ${rule.data.params.SeriesID}`);

// List recording rules
const rules = await axios.get('http://localhost:3000/api/recording-rules');
console.log(`Found ${rules.data.count} recording rules`);
```

### Python

```python
import requests

# Get recent episodes
response = requests.get('http://localhost:3000/api/episodes/recent')
episodes = response.json()

for episode in episodes:
    print(f"{episode['series_title']} - {episode['episode_title']}")

# Get program guide and find shows
guide_response = requests.get('http://localhost:3000/api/guide')
guide = guide_response.json()

print(f"Found {guide['channels']} channels")

# Search for a specific program
search = requests.get('http://localhost:3000/api/guide/search', params={'q': 'news'})
programs = search.json()

for program in programs['results']:
    print(f"{program['title']} on {program['guide_name']}")

# Schedule a recording for a series
recording_rule = {
    'SeriesID': 'C185481ENLBRX',
    'RecentOnly': True,
    'ChannelOnly': '2.1'
}
response = requests.post('http://localhost:3000/api/recording-rules', json=recording_rule)
print(f"Recording rule created: {response.json()['message']}")
```

### Shell Script

```bash
#!/bin/bash

# Trigger discovery
curl -X POST http://localhost:3000/api/discover

# Wait for completion
sleep 60

# Get updated show count
curl http://localhost:3000/api/info | jq '.series'
```

### Home Assistant

```yaml
sensor:
  - platform: rest
    name: HDHomeRun Episodes
    resource: http://localhost:3000/api/info
    value_template: '{{ value_json.episodes }}'
    scan_interval: 3600
```

## Advanced Features

### HDHomeRun Device Sync

The server automatically syncs playback progress with HDHomeRun devices using undocumented APIs discovered through network traffic analysis. This ensures that progress tracking works across the native HDHomeRun apps and this backend.

**What's Synced**:
- Playback position (resume point)
- Watched status
- Recording deletion

**How It Works**:
- Uses `POST /recorded/cmd?id={id}&cmd=set&Resume={position}` for progress updates
- Uses `POST /recorded/cmd?id={id}&cmd=delete&rerecord={0|1}` for deletions
- Special value `4294967295` indicates "watched/completed"

See `HDHOMERUN_PROTOCOL.md` for complete technical details.

### Progress Comparison Tool

Compare playback progress between local database and HDHomeRun devices for all episodes:

```bash
# Compare all episodes
npm run compare-progress

# Compare and automatically sync mismatches
npm run compare-progress --sync-mismatched

# Verbose output
npm run compare-progress --verbose
```

**Output Example**:
```
ID     Series                         Episode                        Status
--------------------------------------------------------------------------------------------------------------
123    Celebrity Jeopardy!            Quarterfinal #7                ✓ IN SYNC
5      All Creatures Great and Small  Homecoming                     ✗ OUT OF SYNC (DB: 30:00, Device: 45:00)
```

### HLS Transcoding

Episodes are automatically converted to HLS format for streaming. The server supports two modes:

**On-Demand Mode** (default):
- Episodes are converted when first requested
- Saves storage space
- May have delay on first playback

**Pre-Cache Mode** (`--pre-cache`):
- All episodes converted after discovery
- Faster playback startup
- Requires more storage space

**Cache Management**:
- Transcoded files stored in `hls-cache/{episodeId}/`
- Each cache includes `transcode.json` with metadata (show name, episode title, air date)
- Old cache cleaned up automatically (30 days default)

## Troubleshooting

### No Devices Found

1. Ensure HDHomeRun devices are powered on and connected to network
2. Check firewall settings - UDP port 65001 must be open
3. Try running with verbose logging: `npm run dev`
4. Manually test discovery: `npm run scan -- --verbose`

### Database Errors

1. Check file permissions on `hdhomerun.db`
2. Ensure sufficient disk space
3. Try deleting database and restarting to rebuild

### API Connection Issues

1. Verify server is running: `curl http://localhost:3000/health`
2. Check CORS settings if accessing from browser
3. Ensure port is not blocked by firewall

### Progress Sync Issues

1. Check that episodes have `cmd_url` field: `node src/device-progress.js get {id}`
2. Verify device is reachable: `curl http://{device_ip}/discover.json`
3. Check server logs for sync errors
4. Use compare tool to identify sync problems: `npm run compare-progress`

### Deletion Issues

1. Ensure device is online before deleting
2. Check that episode has `cmd_url` field
3. HLS cache deletion is best-effort and won't block database deletion
4. Series statistics automatically update via database triggers

## Contributing

Contributions are welcome! Please feel free to submit issues and pull requests.

## License

MIT

## Related Projects

- [HDHomeRun](https://www.silicondust.com/) - Official HDHomeRun hardware and software
- [HDHomeRun DVR](https://www.silicondust.com/dvr-service/) - DVR subscription service

## Credits

Built with:
- [Express.js](https://expressjs.com/) - Web framework
- [Axios](https://axios-http.com/) - HTTP client
- [node-cron](https://github.com/node-cron/node-cron) - Task scheduler
- [asynqlite](https://github.com/punkave/asynqlite) - SQLite interface
