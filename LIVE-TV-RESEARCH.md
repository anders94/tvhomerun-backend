# HDHomeRun Live TV Streaming Research

## Research Summary (Phase 1 Complete)

Date: 2025-12-05
Status: Protocol documented, ready for implementation

## Key Findings

### 1. Live TV Streaming URLs

HDHomeRun devices expose live TV streams via HTTP in MPEG-TS format:

```
http://[device-ip]:5004/[tuner]/v[channel]
```

**Examples:**
- `http://192.168.1.100:5004/auto/v2.1` - Automatic tuner selection, channel 2.1
- `http://192.168.1.100:5004/tuner0/v5.1` - Specific tuner 0, channel 5.1
- `http://192.168.1.100:5004/tuner1/v7.2` - Specific tuner 1, channel 7.2

**Tuner Selection:**
- `/auto/` - Device selects first available tuner
- `/tuner0/`, `/tuner1/`, `/tuner2/`, `/tuner3/` - Specific tuner (device-dependent)

**Channel Formats:**
- Virtual channel: `v5.1` (most common)
- RF frequency: `ch473000000` (frequency in Hz)
- Sub-channel: `ch473000000-3` (frequency + program number)

### 2. Tuner Management

**Automatic Allocation:**
- Tuner is automatically allocated when HTTP connection starts
- Channel is authorized and tuned automatically
- PID filter set automatically
- Stream continues until TCP connection closes or duration expires
- Tuner is released when connection ends

**No Explicit Locking Required:**
For HTTP streaming, we don't need to use the UDP tuner locking API. The HTTP connection itself holds the tuner.

**Error Codes:**
HDHomeRun returns errors via HTTP headers (`X-HDHomeRun-Error`):
- **805** - All tuners in use (no tuners available)
- **804** - Specific tuner in use (when requesting specific tuner)
- **811** - Content protection required (DRM content)

### 3. Channel Lineup Discovery

**Endpoint:** `GET http://[device-ip]/lineup.json`

**Response:**
```json
[
  {
    "GuideNumber": "2.1",
    "GuideName": "WGBH-HD",
    "VideoCodec": "MPEG2",
    "AudioCodec": "AC3",
    "HD": 1,
    "SignalStrength": 100,
    "SignalQuality": 74,
    "URL": "http://192.168.0.37:5004/auto/v2.1"
  }
]
```

**Key Fields:**
- `GuideNumber`: Virtual channel number (e.g., "2.1", "5.1")
- `GuideName`: Station call sign
- `URL`: Ready-to-use streaming URL
- `Tags`: May include "favorite", "drm"

**Alternative Formats:**
- `/lineup.xml` - XML format
- `/lineup.m3u` - M3U playlist format

### 4. Tuner Status Monitoring

**Endpoint:** `GET http://[device-ip]/status.json`

**Response:**
```json
[
  {
    "Resource": "tuner0",
    "InUse": 1,
    "VctNumber": "7.1",
    "VctName": "WHDH-HD",
    "Frequency": 177000000,
    "ProgramNumber": 1,
    "LockSupported": 1,
    "SignalStrength": 100,
    "SignalQuality": 100,
    "NetworkRate": 19392000
  },
  {
    "Resource": "tuner1",
    "InUse": 0
  }
]
```

**Key Fields:**
- `Resource`: Tuner identifier ("tuner0", "tuner1", etc.)
- `InUse`: 0 = available, 1 = in use
- `VctNumber`: Currently tuned channel (when in use)
- `VctName`: Station name (when in use)

**Use Case:**
- Poll `/status.json` to know which tuners are available
- Identify which channel a tuner is currently streaming
- Determine total tuner count

### 5. Stream Format

**Format:** MPEG-TS (MPEG Transport Stream)
**Delivery:** HTTP/TCP continuous stream
**Codecs:** Varies by channel (MPEG2, H.264, AC3, AAC, etc.)

**Client Requirements:**
Clients must implement adaptive timing to match the rate at which data arrives.

**Optional Parameters:**
```
?duration=<seconds>    - Limit stream duration
?transcode=<profile>   - Transcode video (EXTEND models only)
```

Transcode profiles: heavy, mobile, internet540, internet480, internet360, internet240

### 6. Advanced Tuner Control (Optional)

For direct tuner control without HTTP streaming, HDHomeRun provides a UDP-based API:

**Tuner Locking:**
```
set /tuner0/lockkey <random-key>
set /tuner0/channel auto:9
```

**Lock Expiry:**
- Locks expire automatically if idle (no commands, no streaming)
- Typical timeout: 30 seconds of inactivity
- Can force unlock with `set /tuner0/lockkey force`

**Note:** For our HTTP streaming + transcoding use case, we don't need this. The HTTP connection holds the tuner.

## Implementation Strategy

### Recommended Approach

1. **Use HTTP Streaming + FFmpeg Transcoding**
   - Request stream from HDHomeRun: `http://[device]:5004/auto/v[channel]`
   - Pipe to FFmpeg for HLS transcoding
   - No need for explicit tuner locking

2. **Monitor Tuner Availability**
   - Poll `/status.json` periodically (every 30s)
   - Track which tuners are in use
   - Update tuner registry dynamically

3. **Dynamic Tuner Allocation**
   - Check if channel already streaming (reuse FFmpeg output)
   - Check `/status.json` for available tuners
   - Use `/auto/` for first stream, specific tuners for subsequent
   - Handle error 805 (all tuners busy) gracefully

4. **Cache Structure**
   - `live-cache/{deviceId}-tuner-{index}/`
   - Cleanup on device disconnect
   - Cleanup on tuner idle timeout

### FFmpeg Command

```bash
ffmpeg -i http://[device-ip]:5004/tuner0/v2.1 \
  -c:v copy -c:a aac \
  -f hls \
  -hls_time 6 \
  -hls_list_size 10 \
  -hls_flags delete_segments+append_list \
  -hls_segment_filename live-cache/{deviceId}-tuner-{index}/segment-%d.ts \
  live-cache/{deviceId}-tuner-{index}/playlist.m3u8
```

**Notes:**
- Use `-c:v copy` if source is already H.264/HEVC (most modern channels)
- Use `-c:v libx264` for MPEG2 sources (older channels)
- `-hls_list_size` controls rolling window (10 segments = 60s for 6s segments)
- `delete_segments` automatically prunes old segments

## Implementation Phases

### Phase 2: Core Implementation (Ready to Start)

**2.1 Database Schema**
- Add `live_tuners` table
- Add `live_viewers` table

**2.2 Create `src/live-tv.js`**
- TunerManager class
- Integration with device discovery
- Tuner status monitoring
- Client tracking
- Heartbeat system

**2.3 Create `src/live-stream.js`**
- LiveStreamManager class
- FFmpeg process management
- HLS segment pruning
- Error handling

**2.4 API Endpoints**
- `GET /api/live/channels` - Channel lineup
- `POST /api/live/watch` - Start watching
- `POST /api/live/heartbeat` - Keep-alive
- `POST /api/live/stop` - Stop watching
- `GET /api/live/{deviceId}-tuner-{index}/playlist.m3u8` - HLS playlist
- `GET /api/live/{deviceId}-tuner-{index}/:segment` - HLS segments
- `GET /api/live/tuners` - Tuner status (admin)

**2.5 Configuration**
- Add liveTV section to config
- Buffer duration (default: 60 minutes)
- Client heartbeat interval (default: 30s)
- Tuner cooldown (default: 5 minutes)
- Segment pruning interval (default: 30s)

### Phase 3: Testing & Refinement

**3.1 Single Viewer Test**
- Watch channel 2.1
- Verify HLS playback
- Confirm segment pruning
- Test graceful shutdown

**3.2 Multi-Viewer Test**
- Multiple clients on same channel
- Multiple clients on different channels
- Exhaust all tuners
- Test channel switching (PIP)

**3.3 Device Disconnect Test**
- Start streaming
- Disconnect device from network
- Verify cleanup
- Reconnect and verify recovery

**3.4 Client Disconnect Test**
- Stop client abruptly (no /stop call)
- Verify heartbeat timeout
- Confirm tuner cleanup after cooldown

## Open Questions (Resolved)

✅ **Stream URL format:** `http://[device]:5004/[tuner]/v[channel]`
✅ **Tuner allocation:** Automatic via HTTP connection
✅ **Tuner locking:** Not needed for HTTP streaming
✅ **Tuner status:** Available via `/status.json`
✅ **Channel lineup:** Available via `/lineup.json`
✅ **Error handling:** HTTP headers (`X-HDHomeRun-Error`)
✅ **Stream format:** MPEG-TS over HTTP/TCP

## References

- HDHomeRun HTTP API: http://info.hdhomerun.com/info/http_api
- SiliconDust Development Guide: https://www.silicondust.com/hdhomerun/hdhomerun_development.pdf
- Community Forums: https://forum.silicondust.com/
- Existing Protocol Documentation: HDHOMERUN_PROTOCOL.md

## Next Steps

Ready to proceed to Phase 2: Implementation

1. Create database schema for live tuners and viewers
2. Implement TunerManager with device integration
3. Implement LiveStreamManager with FFmpeg
4. Add API endpoints
5. Test with real HDHomeRun device
