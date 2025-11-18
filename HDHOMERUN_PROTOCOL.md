# HDHomeRun Protocol Documentation

This document provides a comprehensive overview of the HDHomeRun device discovery protocol and API endpoints, sufficient for reimplementing HDHomeRun device discovery and DVR content listing functionality.

## Table of Contents

1. [Device Discovery Protocol](#device-discovery-protocol)
2. [HTTP API Endpoints](#http-api-endpoints)
3. [DVR Content Access](#dvr-content-access)
4. [Implementation Guide](#implementation-guide)
5. [External References](#external-references)

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
payload.writeUInt8(0x01, 0);        // HDHOMERUN_TAG_DEVICE_TYPE
payload.writeUInt8(0x04, 1);        // Length: 4 bytes
payload.writeUInt32BE(0xFFFFFFFF, 2); // Device type wildcard
payload.writeUInt8(0x02, 6);        // HDHOMERUN_TAG_DEVICE_ID  
payload.writeUInt8(0x04, 7);        // Length: 4 bytes
payload.writeUInt32BE(0xFFFFFFFF, 8); // Device ID wildcard

const header = Buffer.alloc(4);
header.writeUInt16BE(0x0002, 0);    // HDHOMERUN_TYPE_DISCOVER_REQ
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
  "BaseURL": "http://10.30.2.237",
  "LineupURL": "http://10.30.2.237/lineup.json",
  "TunerCount": 4,
  "StorageID": "10AA5474-13D8-41FA-940C-1F9D2D5D9F8D",
  "StorageURL": "http://10.30.2.237/recorded_files.json",
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
    "URL": "http://10.30.2.237:5004/auto/v2.1"
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
    "EpisodesURL": "http://10.30.2.237/recorded_files.json?SeriesID=C28817988ENAQAO",
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
    "PlayURL": "http://10.30.2.237/recorded/play?id=a63ec6a9404b10f9",
    "CmdURL": "http://10.30.2.237/recorded/cmd?id=a63ec6a9404b10f9"
  }
]
```

**Key Fields**:
- `PlayURL`: Direct streaming URL for the episode
- `Resume`: Playback position in seconds (4294967295 = not started)
- `RecordStartTime`/`RecordEndTime`: Actual recording timestamps
- `StartTime`/`EndTime`: Original broadcast times
- `OriginalAirdate`: When episode originally aired

### Recording Management

#### Recording Rules (Limited Support)
- `/api/recording_rules` - May return 404 on many devices
- `/api/episodes` - Alternative episodes endpoint (often unavailable)

Most HDHomeRun DVR devices focus on playback rather than rule management via API.

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