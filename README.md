# TVHomeRun Web

This is a backend server for the [TVHomeRun](https://github.com/anders94/tvhomerun-appletv) AppleTV app. It is a Node.js API server for [HDHomeRun devices](https://www.silicondust.com/hdhomerun/) that automatically discovers devices on your network and provides REST endpoints and automatic HLS conversions for accessing DVR content. The server runs periodic discovery and maintains a local SQLite database of all devices, shows, and episodes.

## Features

- **Automatic Device Discovery**: Multi-method discovery using UDP broadcast, HTTP fallback, and network scanning
- **DVR Content Management**: Access recorded shows, episodes, and metadata from HDHomeRun DVR devices
- **REST API**: Clean JSON endpoints for integration with web apps, mobile apps, or home automation systems
- **HLS Proxy**: Automatically creates HLS versions of episodes supporting native playback on Apple devices
- **Periodic Sync**: Automatic hourly discovery to keep content up-to-date
- **SQLite Database**: Local storage for offline browsing and fast queries
- **Search & Filter**: Find shows by title, category, or other criteria
- **CORS Enabled**: Ready for browser-based applications

## Prerequisites

- Node.js (v14 or higher)
- HDHomeRun device(s) on your local network
- HDHomeRun DVR subscription (for DVR features)

## Installation

```bash
# Clone the repository
git clone <repository-url>
cd tvhomerun-web

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
    "play_url": "http://192.168.1.100:80/...",
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
- **src/index.js**: CLI discovery tool (accessed via `npm run scan`)

### Discovery Protocol

Implements HDHomeRun's UDP broadcast protocol on port 65001 with proper TLV packet structure and CRC32 validation. Falls back to HTTP discovery service and network scanning for maximum device detection.

See `HDHOMERUN_PROTOCOL.md` for complete protocol documentation.

### Database Schema

Comprehensive SQLite schema with three main tables:

- **devices**: HDHomeRun device tracking with capabilities
- **series**: Show metadata with automatic statistics
- **episodes**: Individual recording details with playback state

The schema includes views, triggers, and indexes for efficient queries and automatic data integrity.

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
tvhomerun-web/
├── src/
│   ├── server.js       # Main API server
│   ├── index.js        # CLI discovery tool
│   ├── discovery.js    # Device discovery
│   ├── dvr.js          # DVR content management
│   └── database.js     # SQLite operations
├── schema.sql          # Database schema
├── CLAUDE.md           # Development guidelines
├── HDHOMERUN_PROTOCOL.md  # Protocol documentation
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
```

### Python

```python
import requests

# Get recent episodes
response = requests.get('http://localhost:3000/api/episodes/recent')
episodes = response.json()

for episode in episodes:
    print(f"{episode['series_title']} - {episode['episode_title']}")
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
