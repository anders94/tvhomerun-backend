# HLS Full-File Caching System

## Overview

The HLS streaming system now uses **full-file caching** instead of rolling segments. This means:
- Entire episodes are transcoded once and cached permanently (30 days)
- Multiple viewers share the same cached content
- Seeking/rewinding works instantly
- Only one FFmpeg process per episode
- Subsequent playback is instant (no re-transcoding)

## Architecture

### Transcoding States

Each episode can be in one of four states:

1. **PENDING**: Not yet transcoded (cache miss)
2. **TRANSCODING**: FFmpeg actively transcoding (first viewer triggers)
3. **COMPLETE**: Fully transcoded and cached (instant playback)
4. **ERROR**: Transcode failed (see error logs)

### Caching Behavior

**First Request:**
- Starts FFmpeg transcode process
- Generates HLS segments progressively
- Playlist updates as segments are created
- Playback can start after ~5-10 seconds
- Transcode continues in background until complete

**Subsequent Requests:**
- Serves from cache immediately
- No FFmpeg process started
- All segments available instantly
- Multiple concurrent viewers supported

### Cache Storage

```
hls-cache/
├── {episodeId}/
│   ├── stream.m3u8          # Master playlist (all segments)
│   ├── segment0000.ts       # First 4-second segment
│   ├── segment0001.ts
│   ├── ...
│   ├── segment9999.ts       # Last segment (max 10,000 segments = ~11 hours)
│   └── transcode.json       # State tracking file
```

**Segment Naming:**
- Format: `segment####.ts` (4-digit zero-padded)
- Capacity: 0000-9999 (10,000 segments maximum)
- Duration: 4 seconds per segment
- Maximum content length: ~11.1 hours

## API Endpoints

### Stream Playlist
```
GET /api/stream/:episodeId/playlist.m3u8
```

Returns HLS playlist. Starts transcode if not cached.

**Response Headers:**
- `Content-Type: application/vnd.apple.mpegurl`
- `Cache-Control: no-cache` (playlist updates during transcode)

### Stream Segment
```
GET /api/stream/:episodeId/:filename
```

Serves individual .ts segment files.

**Response Headers:**
- `Content-Type: video/mp2t`
- `Cache-Control: public, max-age=86400` (24 hour cache)

**Wait Behavior:**
- If transcode is in progress and segment doesn't exist yet
- Waits up to 5 seconds for segment to appear
- Returns 404 if segment still unavailable

### Transcode Status
```
GET /api/stream/:episodeId/status
```

Returns current transcode state and progress.

**Response:**
```json
{
  "episodeId": "3",
  "state": "complete",
  "progress": 100,
  "startTime": 1763490189096,
  "endTime": 1763491234567
}
```

## Configuration

Settings in `src/hls-stream.js`:

```javascript
{
  segmentDuration: 4,        // 4 second segments
  cacheDir: '../hls-cache',  // Cache storage location
  cleanupInterval: 3600000,  // Check for old cache every hour
  maxCacheAge: 2592000000,   // Delete cache after 30 days
  segmentPattern: '%04d'     // 4-digit naming (supports up to 11 hours)
}
```

**Content Length Limits:**
- 3-digit naming (`%03d`): 1,000 segments = 66 minutes max ❌
- 4-digit naming (`%04d`): 10,000 segments = 11.1 hours max ✅

## Cache Management

### Automatic Cleanup
- Runs hourly
- Removes caches older than 30 days
- Based on directory modification time

### Manual Cache Management

**Check cache status:**
```bash
du -sh hls-cache/*          # Size of each cached episode
ls hls-cache/              # List all cached episodes
```

**View transcode state:**
```bash
cat hls-cache/3/transcode.json
```

**Delete specific cache:**
```bash
rm -rf hls-cache/3/
```

**Clear all cache:**
```bash
rm -rf hls-cache/*
```

### Cache on Startup

When the server starts:
1. Scans `hls-cache/` directory
2. Loads state from `transcode.json` files
3. Registers completed transcodes
4. Incomplete transcodes will restart on first request

## Storage Requirements

**Typical episode storage:**
- 30-minute show: ~600-800 MB
- 1-hour show: ~1.2-1.6 GB
- 2-hour movie: ~2.4-3.2 GB

**Calculation:**
- ~5 Mbps average bitrate (video + audio)
- 4-second segments = ~2.5 MB per segment
- 450 segments per 30 minutes = ~1.1 GB

**Disk space planning:**
- 100 episodes @ 30 min each = ~70 GB
- 50 movies @ 2 hours each = ~150 GB

## Performance

### CPU Usage
**During Transcoding:**
- 200-500% CPU per active transcode (multi-threaded)
- Using `veryfast` preset for speed
- Typically completes in 0.8x-1.0x real-time

**During Playback (from cache):**
- <1% CPU (just serving files)
- Disk I/O limited only

### Concurrent Transcodes
- Limited only by CPU/disk
- Each transcode is independent
- Typical system: 2-4 concurrent transcodes

### Concurrent Playback
- Unlimited (cache is shared)
- Pure disk I/O operation
- Network bandwidth is the only limit

## Testing

### Verify Caching Works

```bash
# Request episode for first time
time curl -o /dev/null http://localhost:3000/api/stream/3/playlist.m3u8
# Will take 5-10 seconds (waiting for FFmpeg to start)

# Wait for transcode to complete
watch -n 5 'curl -s http://localhost:3000/api/stream/3/status | grep state'

# Request same episode again
time curl -o /dev/null http://localhost:3000/api/stream/3/playlist.m3u8
# Should be instant (<0.1 seconds)

# Verify cache exists
ls -lh hls-cache/3/
```

### Check No Duplicate FFmpeg Processes

```bash
# Request same episode multiple times in parallel
for i in {1..5}; do
  curl -s http://localhost:3000/api/stream/3/playlist.m3u8 > /dev/null &
done

# Should only see ONE FFmpeg process for episode 3
ps aux | grep ffmpeg | grep segment
```

### Validate Segment Quality

```bash
# Download a segment
curl -o test.ts http://localhost:3000/api/stream/3/segment000.ts

# Inspect with ffprobe
ffprobe -v error -show_format -show_streams test.ts

# Should show:
# - Video: h264, 1920x1080, ~30fps
# - Audio: aac, stereo, 48kHz
```

## Troubleshooting

**Transcode stuck in "transcoding" state:**
- Check server logs for FFmpeg errors
- Verify source URL is accessible
- Check disk space

**Segments returning 404:**
- Check transcode status endpoint
- If state is "error", check transcode.json for details
- May need to delete cache and retry

**High disk usage:**
- Reduce `maxCacheAge` to clean up more frequently
- Monitor `hls-cache/` directory size
- Consider implementing LRU eviction

**Slow transcode performance:**
- Check CPU usage during transcode
- Consider using `faster` or `fast` preset
- Hardware acceleration not yet implemented (future enhancement)

## Future Enhancements

1. **Hardware Acceleration**: Use VideoToolbox/NVENC/VAAPI
2. **Adaptive Bitrate**: Generate multiple quality levels
3. **LRU Eviction**: Keep most recently watched episodes
4. **Pre-transcoding**: Batch transcode at night
5. **Progress Tracking**: Better progress percentage calculation
6. **Partial Cache**: Resume interrupted transcodes
