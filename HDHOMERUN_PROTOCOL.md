# HDHomeRun Protocol Documentation

This document provides a comprehensive overview of the HDHomeRun device discovery protocol and API endpoints, sufficient for reimplementing HDHomeRun device discovery and DVR content listing functionality.

## Table of Contents

1. [Device Discovery Protocol](#device-discovery-protocol)
2. [HTTP API Endpoints](#http-api-endpoints)
3. [Live TV Streaming](#live-tv-streaming)
4. [DVR Content Access](#dvr-content-access)
5. [Recording Rules Management](#recording-rules-management)
6. [Program Guide API](#program-guide-api)
7. [Updating DVR Content](#updating-dvr-content)
8. [Implementation Guide](#implementation-guide)
9. [External References](#external-references)

## Device Discovery Protocol

### UDP Discovery Protocol

HDHomeRun devices are discovered using UDP broadcast packets on **port 65001**.

#### Discovery Packet Structure

The discovery protocol uses a Type-Length-Value (TLV) packet format:

```
[Header: 4 bytes] [Payload: TLV data] [CRC32: 4 bytes]

Header Format:
- Bytes 0-1: Packet Type (uint16_be) - 0x0002 for discovery request
- Bytes 2-3: Payload Length (uint16_be) - length of TLV data

Payload Format (TLV):
- Tag: 1 byte
- Length: 1 byte (for lengths ≤ 127) or 2 bytes (for lengths ≥ 128)
- Value: Variable length data

CRC32: 32-bit CRC checksum (little-endian)
```

#### Discovery Request Packet

To discover all HDHomeRun devices, send a UDP broadcast to `255.255.255.255:65001`:

```javascript
// Example discovery packet construction
const payload = Buffer.alloc(12);
payload.writeUInt8(0x01, 0);             // HDHOMERUN_TAG_DEVICE_TYPE
payload.writeUInt8(0x04, 1);             // Length: 4 bytes
payload.writeUInt32BE(0xFFFFFFFF, 2);    // Device type wildcard
payload.writeUInt8(0x02, 6);             // HDHOMERUN_TAG_DEVICE_ID  
payload.writeUInt8(0x04, 7);             // Length: 4 bytes
payload.writeUInt32BE(0xFFFFFFFF, 8);    // Device ID wildcard

const header = Buffer.alloc(4);
header.writeUInt16BE(0x0002, 0);         // HDHOMERUN_TYPE_DISCOVER_REQ
header.writeUInt16BE(payload.length, 2); // Payload length

// Calculate CRC32 and append
const packetWithoutCrc = Buffer.concat([header, payload]);
const crc = calculateCRC32(packetWithoutCrc);
const crcBuffer = Buffer.alloc(4);
crcBuffer.writeUInt32LE(crc, 0);

const discoveryPacket = Buffer.concat([packetWithoutCrc, crcBuffer]);
```

#### Discovery Response Parsing

Devices respond with similar TLV-formatted packets containing:

- **Tag 0x01**: Device Type (4 bytes)
  - 0x00000001: Tuner device
  - 0x00000005: Storage/DVR device
- **Tag 0x02**: Device ID (4 bytes, hex-encoded)
- **Tag 0x03**: Tuner Count (1 byte)

#### CRC32 Calculation

Uses standard CRC32 algorithm with polynomial 0xEDB88320:

```javascript
function calculateCRC32(data) {
  const crcTable = [];
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let j = 0; j < 8; j++) {
      c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    }
    crcTable[i] = c;
  }

  let crc = 0xFFFFFFFF;
  for (let i = 0; i < data.length; i++) {
    crc = crcTable[(crc ^ data[i]) & 0xFF] ^ (crc >>> 8);
  }
  return (crc ^ 0xFFFFFFFF) >>> 0;
}
```

### Alternative Discovery Methods

1. **HTTP Discovery Service**: `https://my.hdhomerun.com/discover`
   - Returns JSON array of registered devices with LocalIP and BaseURL
   - Requires internet connectivity

2. **Network Scanning**: Direct HTTP requests to common IP ranges
   - Try `http://IP/discover.json` on subnet IPs
   - Filter responses containing "hdhomerun" in ModelNumber

## HTTP API Endpoints

All HTTP endpoints use the device's IP address discovered via UDP protocol.

### Core Device Information

#### `/discover.json`
**Method**: GET  
**Description**: Primary device information endpoint

**Response Format**:
```json
{
  "FriendlyName": "HDHomeRun FLEX 4K",
  "ModelNumber": "HDFX-4K", 
  "FirmwareName": "hdhomerun_dvr_atsc3",
  "FirmwareVersion": "20250623",
  "DeviceID": "10AA5474",
  "DeviceAuth": "3KFU8ZYZnKADs5SHUXWWuqLb",
  "UpgradeAvailable": "20250815",
  "BaseURL": "http://192.168.0.37",
  "LineupURL": "http://192.168.0.37/lineup.json",
  "TunerCount": 4,
  "StorageID": "10AA5474-13D8-41AF-940C-1F9D2D5D9F8D",
  "StorageURL": "http://192.168.0.37/recorded_files.json",
  "TotalSpace": 2000000000000,
  "FreeSpace": 1500000000000
}
```

**Key Fields**:
- `StorageURL`: Indicates DVR capability if present
- `StorageID`: Unique identifier for DVR storage
- `TotalSpace`/`FreeSpace`: Storage capacity in bytes

#### `/lineup.json` 
**Method**: GET  
**Description**: Available TV channels and their streaming URLs

**Response Format**:
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

#### `/status.json`
**Method**: GET  
**Description**: Current tuner status and usage

**Response Format**:
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
  }
]
```

### Storage Detection

To detect DVR storage capability, check for:

1. **StorageURL field** in `/discover.json`
2. **Successful response** from `/recorded_files.json`
3. **Storage API endpoints** (less common):
   - `/api/storage`
   - `/storage.json`

## Live TV Streaming

HDHomeRun devices provide live TV streaming via HTTP in MPEG Transport Stream (MPEG-TS) format.

### Stream URL Format

```
http://[device-ip]:5004/[tuner]/v[channel]
```

**Components:**
- `[device-ip]`: Device IP address (e.g., `192.168.1.100`)
- `[tuner]`: Tuner selector
  - `/auto/` - Automatic tuner selection (first available)
  - `/tuner0/`, `/tuner1/`, `/tuner2/`, `/tuner3/` - Specific tuner
- `v[channel]`: Virtual channel number (e.g., `v2.1`, `v5.1`)

**Examples:**
```
http://192.168.1.100:5004/auto/v2.1        # Auto tuner, channel 2.1
http://192.168.1.100:5004/tuner0/v5.1      # Specific tuner 0, channel 5.1
http://192.168.1.100:5004/tuner1/ch473000000  # RF frequency tuning
```

### Alternative Channel Formats

**RF Frequency:**
```
ch473000000              # Frequency in Hz
ch473000000-3            # Frequency + program number
```

**Auto Tuning:**
```
auto:9                   # Auto-detect modulation, channel 9
qam:33                   # QAM modulation, channel 33
```

### Optional Query Parameters

**Duration Limit:**
```
?duration=<seconds>
```
Automatically closes stream after specified duration.

**Transcoding (EXTEND models only):**
```
?transcode=<profile>
```

Available profiles:
- `heavy` - High quality transcode
- `mobile` - Mobile device optimization
- `internet540`, `internet480`, `internet360`, `internet240` - Resolution-specific

**Example:**
```
http://192.168.1.100:5004/auto/v2.1?duration=3600&transcode=mobile
```

### Tuner Allocation & Management

**Automatic Allocation:**
1. HTTP connection initiates tuner allocation
2. Channel is authorized and tuned automatically
3. PID filter configured automatically
4. Stream delivered continuously over TCP
5. Tuner released when connection closes

**No Explicit Locking Required:**
The HTTP connection itself holds the tuner. No separate locking mechanism needed for HTTP streaming.

**Tuner Availability:**
- `/auto/` selects first available tuner
- Returns HTTP error if all tuners busy
- Specific tuner requests (`/tuner0/`) return error if that tuner is in use

### Error Handling

Errors returned via HTTP header: `X-HDHomeRun-Error`

**Common Error Codes:**
- **805** - All tuners in use (no tuners available)
- **804** - Specified tuner in use (when requesting specific tuner)
- **811** - Content protection required (DRM/encrypted content)

**Example:**
```
HTTP/1.1 503 Service Unavailable
X-HDHomeRun-Error: 805
Content-Length: 0
```

**Error Handling Strategy:**
```javascript
const response = await axios.get(streamUrl, {
  validateStatus: () => true  // Don't throw on non-2xx
});

if (response.status === 503) {
  const errorCode = response.headers['x-hdhomerun-error'];
  if (errorCode === '805') {
    throw new Error('All tuners are currently in use');
  } else if (errorCode === '811') {
    throw new Error('Channel requires subscription/authentication');
  }
}
```

### Channel Lineup Discovery

#### `/lineup.json`
**Method:** GET
**Description:** Returns all available channels with streaming URLs

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
  },
  {
    "GuideNumber": "5.1",
    "GuideName": "WCVB-HD",
    "VideoCodec": "H264",
    "AudioCodec": "AAC",
    "HD": 1,
    "Favorite": 1,
    "SignalStrength": 95,
    "SignalQuality": 80,
    "URL": "http://192.168.0.37:5004/auto/v5.1"
  }
]
```

**Key Fields:**
- `GuideNumber`: Virtual channel number (user-facing channel)
- `GuideName`: Station call sign
- `URL`: Ready-to-use streaming URL
- `VideoCodec`: `MPEG2`, `H264`, `HEVC`
- `AudioCodec`: `AC3`, `AAC`, `EAC3`
- `HD`: `1` for HD, `0` for SD
- `SignalStrength`: 0-100
- `SignalQuality`: 0-100
- `Favorite`: `1` if marked as favorite
- `DRM`: `1` if content protected

**Alternative Formats:**
```
/lineup.xml    # XML format
/lineup.m3u    # M3U playlist format
```

### Tuner Status Monitoring

#### `/status.json`
**Method:** GET
**Description:** Real-time tuner status and usage

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
    "NetworkRate": 19392000,
    "TargetIP": "192.168.1.50"
  },
  {
    "Resource": "tuner1",
    "InUse": 0
  },
  {
    "Resource": "tuner2",
    "InUse": 1,
    "VctNumber": "2.1",
    "VctName": "WGBH-HD",
    "Frequency": 179000000,
    "SignalStrength": 100,
    "SignalQuality": 95
  },
  {
    "Resource": "tuner3",
    "InUse": 0
  }
]
```

**Key Fields:**
- `Resource`: Tuner identifier (`tuner0`, `tuner1`, etc.)
- `InUse`: `0` = available, `1` = in use
- `VctNumber`: Currently tuned channel (when `InUse: 1`)
- `VctName`: Station name (when `InUse: 1`)
- `Frequency`: RF frequency in Hz
- `SignalStrength`: 0-100 (when tuned)
- `SignalQuality`: 0-100 (when tuned)
- `TargetIP`: IP address of client receiving stream (when available)

**Use Cases:**
- Determine total tuner count
- Check tuner availability before allocation
- Identify which channel each tuner is streaming
- Monitor signal quality
- Detect which clients are connected

**Polling Strategy:**
```javascript
// Poll every 30 seconds to track tuner usage
setInterval(async () => {
  const status = await axios.get('http://192.168.1.100/status.json');
  const availableTuners = status.data.filter(t => t.InUse === 0).length;
  console.log(`Available tuners: ${availableTuners}`);
}, 30000);
```

### Stream Format Details

**Format:** MPEG Transport Stream (MPEG-TS)
**Delivery:** HTTP/TCP continuous stream
**Codecs:** Varies by broadcast (MPEG2, H.264, HEVC, AC3, AAC, EAC3)

**Bitrates (typical):**
- HD channels: 10-20 Mbps
- SD channels: 3-8 Mbps

**Client Requirements:**
Clients must implement adaptive timing to match the rate at which data arrives from the device. Do not assume fixed frame rates.

### Transcoding to HLS

For web/mobile playback, transcode MPEG-TS to HLS using FFmpeg:

```bash
# Basic transcoding (copy video if H.264, transcode audio)
ffmpeg -i http://192.168.1.100:5004/auto/v2.1 \
  -c:v copy \
  -c:a aac \
  -f hls \
  -hls_time 6 \
  -hls_list_size 10 \
  -hls_flags delete_segments+append_list \
  -hls_segment_filename /path/to/cache/segment-%d.ts \
  /path/to/cache/playlist.m3u8

# Transcode video (for MPEG2 sources)
ffmpeg -i http://192.168.1.100:5004/auto/v2.1 \
  -c:v libx264 -preset ultrafast -crf 23 \
  -c:a aac -b:a 128k \
  -f hls \
  -hls_time 6 \
  -hls_list_size 10 \
  -hls_flags delete_segments+append_list \
  -hls_segment_filename /path/to/cache/segment-%d.ts \
  /path/to/cache/playlist.m3u8
```

**HLS Parameters:**
- `-hls_time 6`: 6-second segments (standard)
- `-hls_list_size 10`: Keep last 10 segments (60 seconds buffer)
- `delete_segments`: Automatically prune old segments
- `append_list`: Add segments to existing playlist

**Benefits:**
- Native iOS/Safari playback
- Adaptive bitrate support
- Client-side buffering
- No Flash required

### Advanced Tuner Control (Optional)

For applications requiring explicit tuner control without HTTP streaming, use the UDP control API:

**Lock a Tuner:**
```
set /tuner0/lockkey <random-32bit-number>
set /tuner0/channel auto:9
```

**Release Lock:**
```
set /tuner0/lockkey none
```

**Force Unlock:**
```
set /tuner0/lockkey force
```

**Lock Timeout:**
- Locks automatically expire after ~30 seconds of inactivity
- No commands sent and no active stream = idle
- Prevents orphaned locks from crashed applications

**Note:** For HTTP streaming applications, explicit locking is unnecessary. The HTTP connection holds the tuner automatically.

### Implementation Best Practices

1. **Use `/auto/` for first stream** - Let device choose optimal tuner
2. **Check `/status.json` before allocation** - Know available tuners
3. **Handle error 805 gracefully** - All tuners busy
4. **Keep HTTP connection alive** - Connection close releases tuner
5. **Implement timeout on client side** - Detect stalled streams
6. **Monitor signal quality** - Alert on poor signal (<70%)
7. **Cache `/lineup.json`** - Minimize device queries
8. **Respect DRM flags** - Don't attempt to stream protected content

### Multi-Device Considerations

When managing multiple HDHomeRun devices:

```javascript
// Track tuners per device
const tunerPool = new Map();

for (const device of devices) {
  const status = await axios.get(`http://${device.ip}/status.json`);
  for (const tuner of status.data) {
    tunerPool.set(`${device.id}-${tuner.Resource}`, {
      deviceId: device.id,
      deviceIp: device.ip,
      tunerIndex: tuner.Resource.replace('tuner', ''),
      inUse: tuner.InUse === 1,
      channel: tuner.VctNumber || null,
      streamUrl: `http://${device.ip}:5004/${tuner.Resource}/v{channel}`
    });
  }
}

// Find available tuner
function findAvailableTuner() {
  for (const [tunerId, tuner] of tunerPool.entries()) {
    if (!tuner.inUse) {
      return tunerId;
    }
  }
  return null; // All tuners busy
}
```

## DVR Content Access

### Series-Level Content

#### `/recorded_files.json`
**Method**: GET  
**Description**: List of recorded series/shows

**Response Format**:
```json
[
  {
    "SeriesID": "C28817988ENAQAO",
    "Title": "2025 Masters Tournament",
    "Category": "sport", 
    "ImageURL": "https://img.hdhomerun.com/titles/C28817988ENAQAO.jpg",
    "StartTime": 1744567200,
    "EpisodesURL": "http://192.168.0.37/recorded_files.json?SeriesID=C28817988ENAQAO",
    "UpdateID": 2660457045
  }
]
```

**Key Fields**:
- `EpisodesURL`: URL to fetch individual episodes for this series
- `StartTime`: Unix timestamp of series start
- `SeriesID`: Unique identifier for the series

### Episode-Level Content

#### `/recorded_files.json?SeriesID={id}`
**Method**: GET  
**Description**: Detailed episode list for a specific series

**Response Format**:
```json
[
  {
    "Category": "sport",
    "ChannelImageURL": "https://img.hdhomerun.com/channels/US20431.png",
    "ChannelName": "WBZDT",
    "ChannelNumber": "4.1", 
    "EndTime": 1744585200,
    "EpisodeTitle": "Final Round",
    "EpisodeNumber": "S05E07",
    "FirstAiring": 1,
    "ImageURL": "https://img.hdhomerun.com/titles/C28817988ENAQAO.jpg",
    "OriginalAirdate": 1744502400,
    "ProgramID": "EP054158040004",
    "RecordEndTime": 1744585230, 
    "RecordStartTime": 1744569642,
    "Resume": 4294967295,
    "SeriesID": "C28817988ENAQAO",
    "StartTime": 1744567200,
    "Synopsis": "Rory McIlroy tries to complete the career grand slam...",
    "Title": "2025 Masters Tournament",
    "Filename": "2025 Masters Tournament 20250413 [20250413-1800].mpg",
    "PlayURL": "http://192.168.0.37/recorded/play?id=a63ec6a9404b10f9",
    "CmdURL": "http://192.168.0.37/recorded/cmd?id=a63ec6a9404b10f9"
  }
]
```

**Key Fields**:
- `PlayURL`: Direct streaming URL for the episode
- `Resume`: Playback position in seconds (4294967295 = not started)
- `RecordStartTime`/`RecordEndTime`: Actual recording timestamps
- `StartTime`/`EndTime`: Original broadcast times
- `OriginalAirdate`: When episode originally aired

### Recording Rules Management

HDHomeRun uses a **cloud-based architecture** for managing recording schedules. Recording rules are stored and managed through HDHomeRun's cloud API, and devices are notified to synchronize when rules change.

#### Architecture Overview

1. **Cloud API** (`api.hdhomerun.com`) - Manages recording rules
2. **Local Device Sync** - Device endpoint to trigger rule synchronization
3. **DeviceAuth** - Authentication token obtained from `/discover.json`

#### Cloud API Base Endpoint

**Base URL**: `https://api.hdhomerun.com/api/recording_rules`

**Authentication**: All requests require the `DeviceAuth` parameter, which is obtained from the device's `/discover.json` endpoint.

```json
// From /discover.json
{
  "DeviceAuth": "3KFU8ZYZnKADs5SHUXWWuqLb",
  ...
}
```

#### List Recording Rules

**Method**: GET
**Endpoint**: `https://api.hdhomerun.com/api/recording_rules?DeviceAuth={auth}`

**Response Format**:
```json
[
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
]
```

**Response Details**:
- Returns array of recording rules ordered by:
  1. DateTimeOnly rules first (one-time recordings)
  2. Series rules by priority (highest first)
- Returns `null` if no recording rules exist

#### Create Series Recording Rule

**Method**: POST
**Endpoint**: `https://api.hdhomerun.com/api/recording_rules`
**Content-Type**: `application/x-www-form-urlencoded` or query parameters

**Parameters**:

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| DeviceAuth | string | Yes | Authentication token from device |
| Cmd | string | Yes | Must be "add" |
| SeriesID | string | Yes | Series identifier (e.g., "C18361200EN88S3") |
| ChannelOnly | string | No | Pipe-separated channel numbers (e.g., "2.1\|4.1") |
| TeamOnly | string | No | Pipe-separated team names (for sports) |
| RecentOnly | bool | No | Record only new episodes (0 or 1, default: 0) |
| AfterOriginalAirdateOnly | int64 | No | Unix timestamp - only record episodes after this date |
| StartPadding | uint | No | Seconds before start (default: 30, max: 3600) |
| EndPadding | uint | No | Seconds after end (default: 30, max: 10800) |

**Example Request**:
```bash
curl -X POST "https://api.hdhomerun.com/api/recording_rules" \
  -d "DeviceAuth=3KFU8ZYZnKADs5SHUXWWuqLb" \
  -d "Cmd=add" \
  -d "SeriesID=C18361200EN88S3" \
  -d "ChannelOnly=2.1" \
  -d "RecentOnly=1" \
  -d "StartPadding=60" \
  -d "EndPadding=60"
```

**JavaScript Example**:
```javascript
const axios = require('axios');

async function createSeriesRecording(deviceAuth, seriesId, options = {}) {
  const params = new URLSearchParams({
    DeviceAuth: deviceAuth,
    Cmd: 'add',
    SeriesID: seriesId,
    ...options
  });

  const response = await axios.post(
    'https://api.hdhomerun.com/api/recording_rules',
    params
  );

  return response.data;
}

// Usage
await createSeriesRecording('3KFU8ZYZnKADs5SHUXWWuqLb', 'C18361200EN88S3', {
  ChannelOnly: '2.1',
  RecentOnly: 1,
  StartPadding: 60,
  EndPadding: 60
});
```

#### Create One-Time Recording Rule

**Method**: POST
**Endpoint**: `https://api.hdhomerun.com/api/recording_rules`

One-time recordings target a specific airing of a program.

**Required Parameters**:
- `DeviceAuth` - Authentication token
- `Cmd` - Must be "add"
- `SeriesID` - Series identifier
- `DateTimeOnly` - Unix timestamp of specific airing
- `ChannelOnly` - Single channel number (required for one-time recordings)

**Optional Parameters**:
- `StartPadding` - Seconds before (default: 30, max: 3600)
- `EndPadding` - Seconds after (default: 30, max: 10800)

**Example Request**:
```bash
curl -X POST "https://api.hdhomerun.com/api/recording_rules" \
  -d "DeviceAuth=3KFU8ZYZnKADs5SHUXWWuqLb" \
  -d "Cmd=add" \
  -d "SeriesID=C18361200EN88S3" \
  -d "DateTimeOnly=1744567200" \
  -d "ChannelOnly=2.1"
```

**JavaScript Example**:
```javascript
async function createOneTimeRecording(deviceAuth, seriesId, dateTime, channel) {
  const params = new URLSearchParams({
    DeviceAuth: deviceAuth,
    Cmd: 'add',
    SeriesID: seriesId,
    DateTimeOnly: dateTime.toString(),
    ChannelOnly: channel
  });

  const response = await axios.post(
    'https://api.hdhomerun.com/api/recording_rules',
    params
  );

  return response.data;
}

// Usage - schedule recording for specific date/time
const airDateTime = Math.floor(new Date('2025-04-15T18:00:00Z').getTime() / 1000);
await createOneTimeRecording('3KFU8ZYZnKADs5SHUXWWuqLb', 'C18361200EN88S3', airDateTime, '2.1');
```

**Important Notes**:
- One-time recordings auto-expire after the scheduled time passes
- Both `DateTimeOnly` and `ChannelOnly` are mandatory for one-time recordings
- Multiple one-time rules can exist for the same series
- One-time recordings always have highest priority

#### Delete Recording Rule

**Method**: POST
**Endpoint**: `https://api.hdhomerun.com/api/recording_rules`

**Parameters**:
- `DeviceAuth` - Authentication token
- `Cmd` - Must be "delete"
- `RecordingRuleID` - ID of rule to delete

**Example Request**:
```bash
curl -X POST "https://api.hdhomerun.com/api/recording_rules" \
  -d "DeviceAuth=3KFU8ZYZnKADs5SHUXWWuqLb" \
  -d "Cmd=delete" \
  -d "RecordingRuleID=7897331"
```

**JavaScript Example**:
```javascript
async function deleteRecordingRule(deviceAuth, ruleId) {
  const params = new URLSearchParams({
    DeviceAuth: deviceAuth,
    Cmd: 'delete',
    RecordingRuleID: ruleId
  });

  const response = await axios.post(
    'https://api.hdhomerun.com/api/recording_rules',
    params
  );

  return response.data;
}

// Usage
await deleteRecordingRule('3KFU8ZYZnKADs5SHUXWWuqLb', '7897331');
```

#### Change Recording Rule Priority

**Method**: POST
**Endpoint**: `https://api.hdhomerun.com/api/recording_rules`

**Parameters**:
- `DeviceAuth` - Authentication token
- `Cmd` - Must be "change"
- `RecordingRuleID` - ID of rule to modify
- `AfterRecordingRuleID` - Position reference ("0" for highest priority, or ID of rule to place after)

**Example Request**:
```bash
# Move rule to highest priority
curl -X POST "https://api.hdhomerun.com/api/recording_rules" \
  -d "DeviceAuth=3KFU8ZYZnKADs5SHUXWWuqLb" \
  -d "Cmd=change" \
  -d "RecordingRuleID=7897331" \
  -d "AfterRecordingRuleID=0"

# Move rule after another rule
curl -X POST "https://api.hdhomerun.com/api/recording_rules" \
  -d "DeviceAuth=3KFU8ZYZnKADs5SHUXWWuqLb" \
  -d "Cmd=change" \
  -d "RecordingRuleID=7897331" \
  -d "AfterRecordingRuleID=7939758"
```

**Important Notes**:
- Priority only applies to series/movie rules
- DateTimeOnly-ChannelOnly rules (one-time recordings) always have highest priority
- When tuner conflicts occur, higher priority rules take precedence

#### Local Device Synchronization

After modifying recording rules via the cloud API, the local device must be notified to recalculate its recording schedule.

**Endpoint**: `POST http://{device_ip}/recording_events.post?sync`
**Method**: POST
**Body**: Empty (Content-Length: 0)

This endpoint triggers the device to:
1. Fetch updated recording rules from the cloud API
2. Recalculate the recording schedule
3. Update upcoming recordings list

**Example Request**:
```bash
curl -X POST "http://192.168.1.100/recording_events.post?sync"
```

**JavaScript Example**:
```javascript
async function syncRecordingRules(deviceIp) {
  try {
    const response = await axios.post(
      `http://${deviceIp}/recording_events.post?sync`,
      null,
      { timeout: 5000 }
    );
    return { success: true, status: response.status };
  } catch (error) {
    return { success: false, error: error.message };
  }
}

// Complete workflow: Add rule + sync device
async function addRecordingAndSync(deviceAuth, deviceIp, seriesId, options) {
  // 1. Add recording rule via cloud API
  await createSeriesRecording(deviceAuth, seriesId, options);

  // 2. Notify local device to sync
  await syncRecordingRules(deviceIp);

  console.log('Recording scheduled and device synced');
}
```

**Response**:
- Success: `200 OK` with empty body
- The endpoint returns immediately; sync happens in background

**Important Notes**:
- This endpoint was discovered via network packet capture (tcpdump/Wireshark)
- The request body must be empty
- Multiple devices can be notified if recordings are stored on multiple HDHomeRun DVRs
- The sync is asynchronous; the device processes the update in the background

#### Recording Rule Fields Reference

| Field | Type | Description |
|-------|------|-------------|
| RecordingRuleID | string | Unique identifier for the rule (read-only, assigned by server) |
| SeriesID | string | Series/program identifier from guide data |
| Title | string | Program title (read-only, populated by server) |
| Synopsis | string | Program description (read-only, populated by server) |
| ImageURL | string | Program artwork URL (read-only, populated by server) |
| ChannelOnly | string | Restrict to specific channels (pipe-separated: "2.1\|4.1\|702") |
| TeamOnly | string | Filter by team names for sports (pipe-separated) |
| RecentOnly | bool | Only record new episodes (0 or 1) |
| AfterOriginalAirdateOnly | int64 | Unix timestamp - only episodes with original airdate >= this value |
| DateTimeOnly | int64 | Unix timestamp for one-time recording (requires ChannelOnly) |
| Priority | int | Rule priority for conflict resolution (1 = highest) |
| StartPadding | uint | Seconds to start early (default: 30, max: 3600) |
| EndPadding | uint | Seconds to continue after end (default: 30, max: 10800) |

#### Rule Behavior Notes

**Series vs One-Time Rules**:
- **Series rules**: Persist indefinitely, only one per series
- **One-time rules**: Auto-expire after scheduled time, multiple allowed per series

**Modifying Existing Rules**:
- Sending "add" command with same SeriesID updates the existing rule
- All parameters are replaced (not merged); include all desired settings

**Channel Filtering**:
- `ChannelOnly` accepts multiple channels: "2.1|4.1|702"
- Empty/omitted = record from any channel
- Required for one-time recordings (single channel only)

**Recent Episodes Only**:
- `RecentOnly=1` restricts to episodes marked as "FirstAiring"
- Prevents recording of reruns
- Combine with `AfterOriginalAirdateOnly` for precise control

**AfterOriginalAirdateOnly**:
- Unix timestamp threshold
- Records first-airings and episodes with original airdate >= threshold
- Useful for "catch up from Season X" scenarios

**Padding**:
- Default: 30 seconds before/after
- Useful for handling broadcast timing inconsistencies
- Max values: StartPadding (3600s/1hr), EndPadding (10800s/3hr)

#### Common Recording Scenarios

**Record entire series, new episodes only**:
```javascript
{
  SeriesID: 'C18361200EN88S3',
  RecentOnly: 1
}
```

**Record series on specific channel**:
```javascript
{
  SeriesID: 'C18361200EN88S3',
  ChannelOnly: '2.1',
  RecentOnly: 1
}
```

**Record with custom padding**:
```javascript
{
  SeriesID: 'C18361200EN88S3',
  StartPadding: 120,  // 2 minutes early
  EndPadding: 300     // 5 minutes late
}
```

**Record specific airing only**:
```javascript
{
  SeriesID: 'C18361200EN88S3',
  DateTimeOnly: 1744567200,
  ChannelOnly: '2.1'
}
```

**Record from multiple channels**:
```javascript
{
  SeriesID: 'C18361200EN88S3',
  ChannelOnly: '2.1|4.1|702',
  RecentOnly: 1
}
```

#### Discovery Method

The recording rules API documentation was compiled through:
1. Network packet capture analysis (tcpdump/tshark) of HDHomeRun mobile app
2. Official SiliconDust documentation: https://github.com/Silicondust/documentation/wiki
3. Reverse engineering of the cloud API endpoints

The `/recording_events.post?sync` endpoint was discovered by capturing POST requests with empty bodies in the network traffic.

## Program Guide API

HDHomeRun provides electronic program guide (EPG) data through cloud-based APIs. The guide data spans 14 days (2 weeks forward and 2 weeks back) and requires an active HDHomeRun DVR subscription.

### Overview

**Guide Data Provider**: HDHomeRun sources EPG data from Gracenote (Nielsen), which provides:
- Program titles, descriptions, and synopses
- Episode numbers and titles
- Original air dates
- Series artwork and channel logos
- Category/genre filters

**Subscription Requirement**: Guide data access requires a paid HDHomeRun DVR subscription due to licensing costs.

**Authentication**: All guide API requests require a `DeviceAuth` token obtained from the device's `/discover.json` endpoint.

**Important**: DeviceAuth tokens expire every 8-16 hours and must be refreshed regularly for automated applications.

### Two API Options

HDHomeRun provides two different guide API endpoints for different use cases:

1. **JSON Guide API** - For real-time lookups and selective data retrieval
2. **XMLTV Guide API** - For bulk download and caching (third-party DVR software)

### JSON Guide API

The JSON API is ideal for applications that need to look up current and upcoming programs on demand.

#### Endpoint

**Method**: GET
**URL**: `https://api.hdhomerun.com/api/guide`

#### Parameters

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| DeviceAuth | string | Yes | Authentication token from device |
| Start | int64 | No | Unix timestamp (default: current time) |
| Duration | uint | No | Hours of guide data (default: 4, max: 24) |
| Channel | string | No | Specific channel number, or omit for all channels |

#### Example Request

```bash
# Get 4 hours of guide data for all channels starting now
curl "https://api.hdhomerun.com/api/guide?DeviceAuth=3KFU8ZYZnKADs5SHUXWWuqLb&Duration=4"

# Get 8 hours starting at specific time
curl "https://api.hdhomerun.com/api/guide?DeviceAuth=3KFU8ZYZnKADs5SHUXWWuqLb&Start=1744567200&Duration=8"

# Get guide data for specific channel
curl "https://api.hdhomerun.com/api/guide?DeviceAuth=3KFU8ZYZnKADs5SHUXWWuqLb&Channel=2.1&Duration=12"
```

#### Response Format

```json
[
  {
    "GuideNumber": "2.1",
    "GuideName": "WGBHDT",
    "Affiliate": "PBS",
    "ImageURL": "https://img.hdhomerun.com/channels/US28055.png",
    "Guide": [
      {
        "StartTime": 1764950400,
        "EndTime": 1764952200,
        "Title": "Nova",
        "EpisodeNumber": "S48E15",
        "EpisodeTitle": "Dinosaur Apocalypse",
        "Synopsis": "Scientists uncover new clues about the catastrophic asteroid impact that wiped out the dinosaurs 66 million years ago.",
        "OriginalAirdate": 1633478400,
        "SeriesID": "C184159ENJENN",
        "ImageURL": "https://img.hdhomerun.com/titles/C184159ENJENN.jpg",
        "Filter": [
          "Science"
        ]
      }
    ]
  }
]
```

#### Response Fields

**Channel Level**:
- `GuideNumber` - User-facing channel number (e.g., "2.1")
- `GuideName` - Channel call letters
- `Affiliate` - Network affiliation (PBS, CBS, NBC, etc.)
- `ImageURL` - Channel logo/branding image
- `Guide` - Array of programs for this channel

**Program Level**:
- `StartTime` - Unix timestamp when program starts
- `EndTime` - Unix timestamp when program ends
- `Title` - Program title
- `EpisodeNumber` - Season/episode identifier (e.g., "S48E15")
- `EpisodeTitle` - Episode name (optional)
- `Synopsis` - Program description
- `OriginalAirdate` - Unix timestamp of first broadcast
- `SeriesID` - Unique series identifier (critical for recording rules)
- `ImageURL` - Series artwork
- `Filter` - Array of category tags (Kids, Sports, News, etc.)

**Key Field: SeriesID**

The `SeriesID` field is the critical link between guide data and recording functionality:
- Uniquely identifies each series/show
- Used as primary parameter in recording rules API
- Consistent across all airings and channels
- Format: Alphanumeric string (e.g., "C184159ENJENN")

#### JavaScript Example

```javascript
const axios = require('axios');

async function getGuideData(deviceAuth, options = {}) {
  const params = new URLSearchParams({
    DeviceAuth: deviceAuth,
    ...options
  });

  const response = await axios.get(
    `https://api.hdhomerun.com/api/guide?${params}`
  );

  return response.data;
}

// Get current guide data
const guide = await getGuideData('3KFU8ZYZnKADs5SHUXWWuqLb', {
  Duration: 4
});

// Find programs on specific channel
const channel = guide.find(ch => ch.GuideNumber === '2.1');
console.log(`${channel.Guide.length} programs on ${channel.GuideName}`);

// Extract SeriesID for recording
const program = channel.Guide[0];
console.log(`To record "${program.Title}", use SeriesID: ${program.SeriesID}`);
```

### XMLTV Guide API

The XMLTV API provides complete 14-day guide data in standard XMLTV format, designed for third-party DVR applications (Plex, Jellyfin, Emby, etc.).

#### Endpoint

**Method**: GET
**URL**: `https://api.hdhomerun.com/api/xmltv`

#### Parameters

**Option 1: Device Authentication (Recommended)**
- `DeviceAuth` - Concatenated DeviceAuth strings from all HDHomeRun tuners

**Option 2: Email + Device IDs**
- `Email` - Account email address
- `DeviceIDs` - Comma-separated device identifiers

#### Critical Requirements

1. **Gzip Compression Required**: HTTP client must send `Accept-Encoding: gzip` header
2. **Refresh Schedule**: Use randomized intervals between 20-28 hours (not fixed daily schedules)
3. **No Bulk Downloads**: Don't repeatedly download full guide data unnecessarily

#### Example Requests

```bash
# Using curl with compression (recommended)
curl --compressed "https://api.hdhomerun.com/api/xmltv?DeviceAuth=3KFU8ZYZnKADs5SHUXWWuqLb" > guide.xml

# Explicit gzip header
curl -H "Accept-Encoding: gzip" "https://api.hdhomerun.com/api/xmltv?DeviceAuth=3KFU8ZYZnKADs5SHUXWWuqLb" > guide.xml.gz

# Using email + device IDs
curl --compressed "https://api.hdhomerun.com/api/xmltv?Email=user@example.com&DeviceIDs=10AA5474,10BB6585" > guide.xml
```

#### Response Format

Returns standard XMLTV-formatted XML data:

```xml
<?xml version="1.0" encoding="utf-8"?>
<tv source-info-url="https://www.hdhomerun.com/" source-info-name="HDHomeRun">
  <channel id="US28055.hdhomerun.com">
    <display-name>WGBHDT</display-name>
    <display-name>2.1 WGBHDT</display-name>
    <display-name>2.1</display-name>
    <display-name>PBS</display-name>
    <lcn>2.1</lcn>
    <icon src="https://img.hdhomerun.com/channels/US28055.png" width="360" height="270"/>
  </channel>

  <programme start="20251205093000 +0000" stop="20251205100000 +0000" channel="US28055.hdhomerun.com">
    <title lang="en">Nova</title>
    <sub-title lang="en">Dinosaur Apocalypse</sub-title>
    <desc lang="en">Scientists uncover new clues about the catastrophic asteroid impact that wiped out the dinosaurs 66 million years ago.</desc>
    <date>20211005</date>
    <episode-num system="onscreen">S48E15</episode-num>
    <icon src="https://img.hdhomerun.com/titles/C184159ENJENN.jpg"/>
  </programme>
</tv>
```

#### JavaScript Example

```javascript
const axios = require('axios');
const fs = require('fs');

async function downloadXMLTVGuide(deviceAuth, outputFile) {
  const response = await axios.get(
    `https://api.hdhomerun.com/api/xmltv?DeviceAuth=${deviceAuth}`,
    {
      headers: {
        'Accept-Encoding': 'gzip, deflate'
      },
      decompress: true
    }
  );

  fs.writeFileSync(outputFile, response.data);
  console.log(`Guide data saved to ${outputFile}`);
}

// Download and save guide
await downloadXMLTVGuide('3KFU8ZYZnKADs5SHUXWWuqLb', 'guide.xml');
```

### Authentication & Token Management

#### Obtaining DeviceAuth

The DeviceAuth token is retrieved from any HDHomeRun device on your network:

```bash
# Get device auth from local device
curl -s http://192.168.1.100/discover.json | jq -r '.DeviceAuth'
```

**Response**:
```json
{
  "DeviceAuth": "3KFU8ZYZnKADs5SHUXWWuqLb",
  ...
}
```

#### Token Expiration

**Critical**: DeviceAuth tokens expire every 8-16 hours. Applications must:
1. Fetch fresh token from device before each API call
2. Handle 401/403 errors by refreshing token
3. Cache tokens for short periods only (< 4 hours recommended)

#### Multiple Devices

For households with multiple HDHomeRun units, concatenate all DeviceAuth strings:

```javascript
async function getCombinedDeviceAuth(deviceIps) {
  const authTokens = [];

  for (const ip of deviceIps) {
    const response = await axios.get(`http://${ip}/discover.json`);
    authTokens.push(response.data.DeviceAuth);
  }

  return authTokens.join('');
}

// Usage
const auth = await getCombinedDeviceAuth(['192.168.1.100', '192.168.1.101']);
```

### Guide Data Workflow

Here's how guide data integrates with recording functionality:

```
1. User browses TV guide
   └─> App calls JSON Guide API for current/upcoming programs
   └─> Displays channel lineup with program details

2. User finds interesting program
   └─> App extracts SeriesID from guide data
   └─> Shows "Record Series" button

3. User schedules recording
   └─> App calls Recording Rules API with SeriesID
   └─> Cloud API creates recording rule

4. Device fetches updated rules
   └─> Matches SeriesID in guide to scheduled recordings
   └─> Records matching programs automatically
```

**Example Complete Workflow**:

```javascript
// 1. Get current guide data
const guide = await getGuideData(deviceAuth, { Duration: 8 });

// 2. User selects a program
const channel = guide.find(ch => ch.GuideNumber === '2.1');
const program = channel.Guide[0];

console.log(`User wants to record: ${program.Title}`);
console.log(`SeriesID: ${program.SeriesID}`);

// 3. Create recording rule using SeriesID from guide
const params = new URLSearchParams({
  DeviceAuth: deviceAuth,
  Cmd: 'add',
  SeriesID: program.SeriesID,  // <-- Critical link
  RecentOnly: 1,
  ChannelOnly: channel.GuideNumber
});

await axios.post('https://api.hdhomerun.com/api/recording_rules', params);

// 4. Sync local device
await axios.post(`http://192.168.1.100/recording_events.post?sync`, null);

console.log(`Recording scheduled for "${program.Title}" on ${channel.GuideName}`);
```

### Best Practices

#### For JSON Guide API

1. **Request only what you need**: Use `Duration` parameter to limit data
2. **Filter by channel**: Use `Channel` parameter for single-channel lookups
3. **Cache strategically**: Guide data for near-future doesn't change frequently
4. **Respect rate limits**: Don't poll excessively (every 5-15 minutes is reasonable)

#### For XMLTV Guide API

1. **Use random intervals**: Refresh between 20-28 hours, not fixed schedules
2. **Enable compression**: Always use gzip to reduce bandwidth
3. **Store locally**: Cache the full guide file, don't re-download for every query
4. **Stagger updates**: If managing multiple systems, randomize update times

#### Token Management

1. **Refresh before expiration**: Don't wait for 401 errors
2. **Implement retry logic**: Auto-refresh token on auth failures
3. **Log token age**: Track when token was last fetched

#### Example Caching Strategy

```javascript
class GuideCache {
  constructor(deviceAuth) {
    this.deviceAuth = deviceAuth;
    this.cache = null;
    this.cacheTime = null;
    this.cacheDuration = 15 * 60 * 1000; // 15 minutes
  }

  async getGuide(options = {}) {
    const now = Date.now();

    // Return cached data if fresh
    if (this.cache && (now - this.cacheTime) < this.cacheDuration) {
      return this.cache;
    }

    // Fetch fresh data
    this.cache = await getGuideData(this.deviceAuth, options);
    this.cacheTime = now;

    return this.cache;
  }
}

// Usage
const guideCache = new GuideCache(deviceAuth);
const guide = await guideCache.getGuide({ Duration: 4 });
```

### Common Use Cases

#### Find What's On Now

```javascript
async function getCurrentPrograms(deviceAuth) {
  const now = Math.floor(Date.now() / 1000);
  const guide = await getGuideData(deviceAuth, { Duration: 1 });

  return guide.map(channel => {
    const current = channel.Guide.find(
      prog => prog.StartTime <= now && prog.EndTime > now
    );

    return {
      channel: channel.GuideNumber,
      name: channel.GuideName,
      program: current?.Title || 'No data',
      episode: current?.EpisodeTitle
    };
  });
}
```

#### Search for Series

```javascript
async function searchGuide(deviceAuth, searchTerm) {
  const guide = await getGuideData(deviceAuth, { Duration: 24 });
  const results = [];

  for (const channel of guide) {
    for (const program of channel.Guide) {
      if (program.Title.toLowerCase().includes(searchTerm.toLowerCase())) {
        results.push({
          title: program.Title,
          channel: channel.GuideNumber,
          startTime: new Date(program.StartTime * 1000),
          seriesId: program.SeriesID
        });
      }
    }
  }

  return results;
}

// Find all airings of "Nova"
const results = await searchGuide(deviceAuth, 'nova');
```

#### Get Program by Time Slot

```javascript
async function getProgramAt(deviceAuth, channel, timestamp) {
  const guide = await getGuideData(deviceAuth, {
    Start: timestamp - 3600, // Start 1 hour before
    Duration: 2,
    Channel: channel
  });

  const channelData = guide[0];
  const program = channelData.Guide.find(
    prog => prog.StartTime <= timestamp && prog.EndTime > timestamp
  );

  return program;
}

// What's on channel 2.1 at 8 PM tonight?
const program = await getProgramAt(
  deviceAuth,
  '2.1',
  Math.floor(new Date('2025-12-05T20:00:00').getTime() / 1000)
);
```

### Error Handling

#### Common Errors

**401 Unauthorized / 403 Forbidden**:
- DeviceAuth token expired
- Solution: Fetch fresh token from device

**404 Not Found**:
- Invalid endpoint or parameters
- Solution: Verify API URL and parameter names

**No guide data / Empty response**:
- No active DVR subscription
- Device not properly registered
- Solution: Verify subscription status at my.hdhomerun.com

#### Example Error Handling

```javascript
async function getGuideWithRetry(deviceIp, options = {}) {
  try {
    // Get fresh device auth
    const discover = await axios.get(`http://${deviceIp}/discover.json`);
    const deviceAuth = discover.data.DeviceAuth;

    // Fetch guide data
    const guide = await getGuideData(deviceAuth, options);
    return { success: true, data: guide };

  } catch (error) {
    if (error.response?.status === 401 || error.response?.status === 403) {
      return { success: false, error: 'Authentication failed - token expired' };
    }

    return { success: false, error: error.message };
  }
}
```

### Discovery Method

The guide API documentation was compiled from:
1. Official SiliconDust documentation: https://github.com/Silicondust/documentation/wiki
2. Testing against live HDHomeRun devices
3. Community forum discussions and third-party integration examples

## Updating DVR Content

### Playback Progress Management

HDHomeRun devices support updating playback progress (resume position) via an undocumented HTTP API. This was discovered through network traffic analysis (`tcpdump`) of official HDHomeRun applications.

#### Update Resume Position

**Endpoint**: `/recorded/cmd`
**Method**: POST
**Format**: Query parameters (not form data or JSON)

**Request Format**:
```
POST /recorded/cmd?id={episode_id}&cmd=set&Resume={position}
```

**Parameters**:
- `id`: Episode ID from the `CmdURL` field
- `cmd`: Command type (use `set` for updating progress)
- `Resume`: Position in seconds, or special value for watched status

**Special Resume Values**:
- `4294967295` (max uint32): Marks episode as "watched/completed"
- `0`: Resets to beginning
- Any other positive integer: Resume position in seconds

**Response**:
- Success: `200 OK` with empty body
- Failure: `400 Bad Request` with HTML error page

**Examples**:

Set resume position to 682 seconds:
```bash
curl -X POST "http://192.168.0.37/recorded/cmd?id=901f4f1362e3b3a8&cmd=set&Resume=682"
```

Mark episode as watched:
```bash
curl -X POST "http://192.168.0.37/recorded/cmd?id=901f4f1362e3b3a8&cmd=set&Resume=4294967295"
```

JavaScript/Node.js example:
```javascript
const axios = require('axios');

async function updateProgress(cmdUrl, position, watched) {
  const resumeValue = watched ? '4294967295' : position.toString();
  const url = `${cmdUrl}&cmd=set&Resume=${resumeValue}`;

  try {
    const response = await axios.post(url, null, { timeout: 5000 });
    return { success: true, status: response.status };
  } catch (error) {
    return { success: false, error: error.message };
  }
}

// Usage
await updateProgress(
  'http://192.168.0.37/recorded/cmd?id=901f4f1362e3b3a8',
  682,    // position in seconds
  false   // watched status
);
```

**Important Notes**:
- This API is **undocumented** and not officially supported by SiliconDust
- The `cmd=set` parameter is **required** in the query string
- `Resume` must be a **query parameter**, not form data or JSON body
- The request body should be null/empty
- May not work on all device models or firmware versions
- Discovered via `tcpdump` analysis of official app traffic

**Discovery Method**:
```bash
# Capture traffic while using official HDHomeRun app
sudo tcpdump -i any -A host {device_ip} and port 80

# Look for POST requests to /recorded/cmd
# Extract the query parameter format
```

### Delete Recording

HDHomeRun devices support deleting recordings via the command endpoint.

**Endpoint**: `/recorded/cmd`
**Method**: POST
**Format**: Query parameters

**Request Format**:
```
POST /recorded/cmd?id={episode_id}&cmd=delete&rerecord={0|1}
```

**Parameters**:
- `id`: Episode ID from the `CmdURL` field
- `cmd`: Command type (use `delete` for deletion)
- `rerecord`: Whether to allow re-recording (0 = no, 1 = yes)

**Response**:
- Success: `200 OK` with empty body
- Failure: `400 Bad Request` with HTML error page

**Examples**:

Delete recording without allowing re-record:
```bash
curl -X POST "http://192.168.0.37/recorded/cmd?id=5b46d1de54f373bf&cmd=delete&rerecord=0"
```

Delete recording and allow it to be re-recorded:
```bash
curl -X POST "http://192.168.0.37/recorded/cmd?id=5b46d1de54f373bf&cmd=delete&rerecord=1"
```

JavaScript/Node.js example:
```javascript
const axios = require('axios');

async function deleteRecording(cmdUrl, allowRerecord = false) {
  const url = `${cmdUrl}&cmd=delete&rerecord=${allowRerecord ? '1' : '0'}`;

  try {
    const response = await axios.post(url, null, { timeout: 5000 });
    return { success: true, status: response.status };
  } catch (error) {
    return { success: false, error: error.message };
  }
}

// Usage
await deleteRecording(
  'http://192.168.0.37/recorded/cmd?id=5b46d1de54f373bf',
  false  // rerecord flag
);
```

**Important Notes**:
- Deletion is **permanent** and cannot be undone
- The `rerecord` parameter controls whether the same program can be recorded again
- Setting `rerecord=1` removes the recording but allows future airings to be recorded
- Setting `rerecord=0` prevents the program from being recorded again (useful for unwanted recordings)

### Other Command Types

The `cmd` parameter may support other operations, though these are untested:

**Potential Commands** (unverified):
- `cmd=protect` - Protect from deletion?
- `cmd=rename` - Rename recording?
- `cmd=move` - Move to different storage?

These would require additional network traffic analysis to confirm.

## Implementation Guide

### Basic Implementation Flow

1. **Device Discovery**:
   ```javascript
   // 1. Send UDP broadcast discovery packet
   // 2. Parse responses to extract device IPs and capabilities  
   // 3. Query /discover.json for detailed device information
   // 4. Check for StorageURL to identify DVR devices
   ```

2. **DVR Content Retrieval**:
   ```javascript
   // 1. GET /recorded_files.json → series list
   // 2. For each series, GET EpisodesURL → episode details
   // 3. Parse episode metadata (title, channel, synopsis, etc.)
   // 4. Use PlayURL for streaming access
   ```

3. **Error Handling**:
   - Set reasonable timeouts (3-5 seconds)
   - Handle 404 responses gracefully
   - Implement fallback discovery methods
   - Validate response structures before parsing

### Time Handling

All timestamps are Unix epoch seconds. Convert to Date objects:
```javascript
const startTime = new Date(episode.StartTime * 1000);
```

Resume times may use special values:
- `4294967295`: Not started/no resume point
- Other values: Resume position in seconds

## External References

### Official Documentation
- [HDHomeRun Discovery API](http://info.hdhomerun.com/info/discovery_api)
- [HDHomeRun DVR API](http://info.hdhomerun.com/info/dvr_api)
- [SiliconDust Documentation Wiki](https://github.com/Silicondust/documentation/wiki) - Recording rules, guide API, and DVR operations
- [HDHomeRun Development Guide](https://www.silicondust.com/hdhomerun/hdhomerun_development.pdf)
- [HDHomeRun Discover API PDF](https://www.silicondust.com/hdhomerun/hdhomerun_discover_api.pdf)

### Open Source Implementations
- [libhdhomerun - Official C Library](https://github.com/Silicondust/libhdhomerun)
- [node-hdhomerun - Node.js Implementation](https://github.com/mharsch/node-hdhomerun)
- [HDHomeRun Protocol Docs](https://github.com/waypar/hdhomerun-protocol-docs)

### Community Resources
- [HDHomeRun API Documentation](https://github.com/snemetz/synology/blob/master/HDHomeRun/Doc-APIs.md)
- [SiliconDust Forums](https://forum.silicondust.com/)
- [HDHomeRun Packet Header Format](https://github.com/Silicondust/libhdhomerun/blob/master/hdhomerun_pkt.h)

### Protocol Details
- **Discovery Port**: 65001 (UDP and TCP)
- **HTTP Port**: 80 (default) or as specified in BaseURL
- **Packet Format**: Type-Length-Value with CRC32 checksums
- **Endianness**: Big-endian for packet headers, little-endian for CRC

This documentation should provide sufficient detail to reimplement HDHomeRun device discovery and DVR content access in any programming language.
