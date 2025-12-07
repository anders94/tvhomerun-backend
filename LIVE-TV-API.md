# Live TV API Documentation

## Overview

The Live TV API provides real-time television streaming from HDHomeRun devices via HLS (HTTP Live Streaming). The system manages a dynamic pool of tuners across multiple devices, automatically transcodes MPEG-TS streams to HLS, and supports multiple concurrent viewers on the same channel.

## Architecture

### Components

- **TunerManager** (`src/live-tv.js`) - Manages the dynamic tuner pool and viewer tracking
- **LiveStreamManager** (`src/live-stream.js`) - Handles FFmpeg transcoding to HLS
- **Database** - Tracks tuner states, viewer sessions, and heartbeats

### Key Features

- **Dynamic Tuner Pool**: Tuners from multiple HDHomeRun devices managed as a unified pool
- **Intelligent Allocation**: Reuses active streams when possible, minimizing tuner usage
- **Multi-Viewer Support**: Up to 10 concurrent viewers per tuner (configurable)
- **Automatic Cleanup**: Heartbeat monitoring removes dead clients, idle tuner shutdown
- **Picture-in-Picture**: Clients can request multiple channels simultaneously
- **Rolling HLS Buffer**: Configurable buffer duration (default: 60 minutes)

## API Endpoints

### 1. Get Channel Lineup

```http
GET /api/live/channels
```

Returns all available channels from the program guide.

**Response:**
```json
{
  "channels": [
    {
      "guide_number": "2.1",
      "guide_name": "WGBHDT",
      "affiliate": "PBS",
      "image_url": "https://img.hdhomerun.com/channels/US28055.png"
    },
    ...
  ],
  "count": 45,
  "timestamp": "2025-12-07T04:43:21.691Z"
}
```

### 2. Start Watching Channel

```http
POST /api/live/watch
Content-Type: application/json

{
  "channelNumber": "2.1",
  "clientId": "unique-client-identifier"
}
```

Allocates a tuner for the requested channel. If the channel is already streaming, reuses that tuner.

**Response (Success):**
```json
{
  "success": true,
  "tunerId": "10AA5474-tuner-0",
  "playlistUrl": "/api/live/10AA5474-tuner-0/playlist.m3u8",
  "channelNumber": "2.1"
}
```

**Response (No Tuners Available):**
```json
{
  "error": "No tuners available",
  "message": "All tuners are currently in use"
}
```

**Usage Notes:**
- `clientId` must be unique per viewer session
- Same `clientId` cannot be registered on multiple tuners
- Stream startup takes 5-15 seconds while FFmpeg initializes

### 3. Send Heartbeat

```http
POST /api/live/heartbeat
Content-Type: application/json

{
  "clientId": "unique-client-identifier"
}
```

Updates the viewer's last heartbeat timestamp. Clients must send heartbeats every 30 seconds or less.

**Response:**
```json
{
  "success": true,
  "message": "Heartbeat received"
}
```

**Important:** Missing 2 consecutive heartbeats (60 seconds) will cause automatic viewer cleanup.

### 4. Stop Watching

```http
POST /api/live/stop
Content-Type: application/json

{
  "clientId": "unique-client-identifier"
}
```

Releases the viewer from the tuner. Tuner enters cooldown state if no other viewers remain.

**Response:**
```json
{
  "success": true,
  "message": "Successfully stopped watching"
}
```

### 5. Get HLS Playlist

```http
GET /api/live/:tunerId/playlist.m3u8
```

Retrieves the HLS master playlist for the tuner.

**Response:** HLS playlist file (text/vnd.apple.mpegurl)

### 6. Get HLS Segment

```http
GET /api/live/:tunerId/segment-123.ts
```

Retrieves a specific HLS segment file.

**Response:** MPEG-TS segment (video/mp2t)

### 7. Get Tuner Status (Admin)

```http
GET /api/live/tuners
```

Returns status of all tuners in the system.

**Response:**
```json
{
  "tuners": [
    {
      "id": "10AA5474-tuner-0",
      "deviceId": "10AA5474",
      "deviceIp": "10.30.2.237",
      "tunerIndex": 0,
      "state": "active",
      "channelNumber": "2.1",
      "viewerCount": 2,
      "streamPid": 12345,
      "hlsPath": "live-cache/10AA5474-tuner-0"
    },
    ...
  ],
  "count": 4,
  "timestamp": "2025-12-07T04:42:13.071Z"
}
```

**Tuner States:**
- `idle` - Available for allocation
- `active` - Streaming with viewers
- `cooldown` - No viewers, will stop after timeout (default: 5 minutes)
- `offline` - Device disconnected

## Client Implementation Guide

### Basic Workflow

```javascript
// 1. Get available channels
const channelsResponse = await fetch('/api/live/channels');
const { channels } = await channelsResponse.json();

// 2. Start watching a channel
const clientId = crypto.randomUUID(); // or any unique identifier
const watchResponse = await fetch('/api/live/watch', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    channelNumber: '2.1',
    clientId: clientId
  })
});

const { tunerId, playlistUrl } = await watchResponse.json();

// 3. Load HLS stream in video player
const video = document.querySelector('video');
if (Hls.isSupported()) {
  const hls = new Hls();
  hls.loadSource(playlistUrl);
  hls.attachMedia(video);
} else if (video.canPlayType('application/vnd.apple.mpegurl')) {
  video.src = playlistUrl; // Safari native HLS
}

// 4. Start heartbeat (every 25 seconds)
const heartbeatInterval = setInterval(async () => {
  await fetch('/api/live/heartbeat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ clientId })
  });
}, 25000);

// 5. Stop watching when done
async function stopWatching() {
  clearInterval(heartbeatInterval);
  await fetch('/api/live/stop', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ clientId })
  });
}

// Clean up on page unload
window.addEventListener('beforeunload', () => stopWatching());
```

### Picture-in-Picture Support

```javascript
// Client can watch multiple channels simultaneously
const mainClientId = crypto.randomUUID();
const pipClientId = crypto.randomUUID();

// Main channel
const main = await fetch('/api/live/watch', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ channelNumber: '2.1', clientId: mainClientId })
});

// PIP channel
const pip = await fetch('/api/live/watch', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ channelNumber: '5.1', clientId: pipClientId })
});

// Both streams need separate heartbeats
```

## Configuration

Configuration options in `src/server.js` constructor:

```javascript
const server = new HDHomeRunServer({
  liveTV: true, // Enable/disable live TV (default: true)
  liveTVConfig: {
    cacheDir: 'live-cache',           // HLS cache directory
    bufferMinutes: 60,                // Rolling buffer duration
    segmentDuration: 6,               // HLS segment length (seconds)
    clientHeartbeat: 30,              // Expected heartbeat interval (seconds)
    missedHeartbeats: 2,              // Heartbeats to miss before cleanup
    tunerCooldown: 300,               // Idle time before stopping (seconds)
    maxViewersPerTuner: 10            // Max concurrent viewers per tuner
  }
});
```

## System Behavior

### Tuner Allocation Strategy

1. **Check for active stream**: If channel is already streaming and has capacity, reuse that tuner
2. **Find idle tuner**: Allocate an available idle tuner
3. **Reallocate cooldown tuner**: If no idle tuners, use a tuner in cooldown with no viewers
4. **Return error**: All tuners busy

### Automatic Cleanup

**Dead Client Removal** (runs every 30 seconds):
- Checks for clients that missed 2+ heartbeats
- Automatically releases viewer and decrements tuner viewer count
- Moves tuner to cooldown if no viewers remain

**Idle Tuner Shutdown** (runs every 60 seconds):
- Stops FFmpeg process on tuners in cooldown for 5+ minutes with no viewers
- Cleans up HLS cache directory
- Returns tuner to idle state

### Dynamic Device Management

- Tuners are registered automatically during device discovery
- When device goes offline, all its tuners are marked offline and streams stopped
- When device comes back online, tuners are re-registered and become available
- Tuner IDs include device ID: `{deviceId}-tuner-{index}`

## HLS Transcoding

FFmpeg command used for transcoding:

```bash
ffmpeg \
  -i http://[device-ip]:5004/tuner[N]/v[channel] \
  -c:v copy \              # Copy video (already H.264)
  -c:a aac \               # Transcode audio to AAC
  -b:a 128k \
  -f hls \
  -hls_time 6 \            # 6-second segments
  -hls_list_size 600 \     # Keep 600 segments (60 min at 6s)
  -hls_flags delete_segments+append_list \
  -hls_segment_filename live-cache/{tunerId}/segment-%d.ts \
  live-cache/{tunerId}/playlist.m3u8
```

Segments are automatically pruned by FFmpeg using the `delete_segments` flag.

## Database Schema

### live_tuners Table

```sql
CREATE TABLE live_tuners (
    id TEXT PRIMARY KEY,              -- "{deviceId}-tuner-{index}"
    device_id TEXT NOT NULL,
    tuner_index INTEGER NOT NULL,
    channel_number TEXT,
    state TEXT NOT NULL DEFAULT 'idle',
    stream_pid INTEGER,
    hls_path TEXT,
    started_at DATETIME,
    last_accessed DATETIME,
    viewer_count INTEGER DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
```

### live_viewers Table

```sql
CREATE TABLE live_viewers (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tuner_id TEXT NOT NULL,
    client_id TEXT NOT NULL UNIQUE,   -- One viewer per client
    channel_number TEXT NOT NULL,
    last_heartbeat DATETIME DEFAULT CURRENT_TIMESTAMP,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
```

## Troubleshooting

### No Tuners Available

- Check `/api/live/tuners` to see current tuner allocation
- Verify devices are online and discovered
- Consider increasing `maxViewersPerTuner` if many clients watch same channel

### Stream Fails to Start

- Check FFmpeg is installed and in PATH
- Verify HDHomeRun device is accessible at reported IP
- Check server logs for FFmpeg errors
- Confirm channel number is valid (check `/api/live/channels`)

### Viewers Not Cleaned Up

- Verify heartbeat interval is < 30 seconds
- Check that heartbeat requests are reaching server
- Review background task logs (runs every 30s)

### High Disk Usage

- Reduce `bufferMinutes` config setting
- Check that FFmpeg `delete_segments` flag is working
- Verify idle tuner cleanup is running (every 60s)

## Examples

### curl Examples

```bash
# Get channels
curl http://localhost:3000/api/live/channels

# Start watching
curl -X POST http://localhost:3000/api/live/watch \
  -H "Content-Type: application/json" \
  -d '{"channelNumber":"2.1","clientId":"test-client-1"}'

# Send heartbeat
curl -X POST http://localhost:3000/api/live/heartbeat \
  -H "Content-Type: application/json" \
  -d '{"clientId":"test-client-1"}'

# Stop watching
curl -X POST http://localhost:3000/api/live/stop \
  -H "Content-Type: application/json" \
  -d '{"clientId":"test-client-1"}'

# Check tuner status
curl http://localhost:3000/api/live/tuners

# Play with ffplay
ffplay http://localhost:3000/api/live/10AA5474-tuner-0/playlist.m3u8
```

## Performance Considerations

- Each active tuner runs an FFmpeg process (CPU and memory usage)
- HLS segments accumulate on disk (default: ~3.6 GB per hour per tuner at 8 Mbps)
- Network bandwidth: ~8-10 Mbps per viewer (uncompressed from device, compressed to clients)
- Recommended: Monitor disk space in `live-cache/` directory

## Future Enhancements

Potential improvements for future implementation:

- Quality/bitrate selection for transcoding
- DVR-style pause/rewind using buffered segments
- Recording live TV to DVR
- Channel change without stopping stream (seamless switching)
- Thumbnail previews from live streams
- Multi-audio track support
- Closed caption support
