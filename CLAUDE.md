# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

This is a Node.js API server for HDHomeRun devices that automatically discovers devices on the network and provides REST endpoints for accessing DVR content. The server runs periodic discovery (every hour) and maintains a local SQLite database of all devices, shows, and episodes.

## Development Commands

### Running the API Server
```bash
npm start          # Start API server on port 3000
npm run dev        # Development mode with verbose logging
npm run debug      # Same as dev mode
npm run scan       # Run original CLI discovery tool
```

### Command Line Options
- `--verbose` or `-v`: Enable debug logging for discovery and API operations
- `PORT` environment variable: Set server port (default: 3000)

## Architecture Overview

### Core Components

**src/server.js** - Main API server entry point
- Express.js-based REST API with CORS support
- Automatic hourly discovery using node-cron scheduler  
- JSON endpoints for shows, episodes, and system information
- Graceful error handling and logging throughout

**src/index.js** - Original CLI discovery tool (now available via `npm run scan`)
- Orchestrates device discovery, DVR content retrieval, and database synchronization
- Handles command-line arguments and error reporting
- Provides comprehensive output formatting for discovered devices and content

**src/discovery.js** - HDHomeRun device discovery engine  
- Implements UDP broadcast protocol with proper CRC32 packet formatting
- Falls back to HTTP discovery service (my.hdhomerun.com) and network scanning
- Handles device capability detection (tuners vs DVR storage devices)
- Multi-method discovery approach ensures maximum device detection

**src/dvr.js** - DVR content management
- Retrieves recorded shows and episodes via HDHomeRun HTTP APIs
- Parses series metadata and episode details (titles, channels, timing, etc.)
- Provides utilities for file size formatting and duration calculations
- Handles storage information and recording rules

**src/database.js** - SQLite data persistence
- Complete CRUD operations for devices, series, and episodes  
- Automatic schema creation and migration support
- Maintains referential integrity with foreign key constraints
- API-specific query methods: getAllSeries(), getEpisodesBySeriesId(), searchSeries(), etc.
- Provides statistics and summary views for content analysis

### Key Technical Details

**Discovery Protocol**: Implements HDHomeRun's UDP broadcast protocol on port 65001 with proper TLV packet structure and CRC32 validation. See HDHOMERUN_PROTOCOL.md for complete protocol documentation.

**Database Schema**: Comprehensive SQLite schema (schema.sql) with devices, series, and episodes tables, including automated statistics tracking via triggers.

**HTTP APIs**: Extensive use of HDHomeRun's HTTP endpoints including `/discover.json`, `/recorded_files.json`, and series-specific episode URLs.

**Error Handling**: Robust error handling with multiple fallback discovery methods, timeout management, and graceful degradation when endpoints are unavailable.

## Dependencies

- **express**: Web framework for REST API server
- **cors**: Cross-origin resource sharing middleware
- **node-cron**: Task scheduler for periodic discovery
- **axios**: HTTP client for API requests to HDHomeRun devices
- **asynqlite**: SQLite database interface with promise-based operations
- **dgram**: Built-in Node.js UDP socket support for device discovery
- **os**: Built-in Node.js OS interface for network interface detection

## API Endpoints

### Server Information
- `GET /health` - Health check with server status
- `GET /api/info` - API statistics and discovery status

### Shows/Series
- `GET /api/shows` - All shows with optional search, category, and limit filters
- `GET /api/shows/:id` - Specific show details by series ID
- `GET /api/shows/:id/episodes` - Episodes for a show with filtering options

### Episodes
- `GET /api/episodes/recent` - Recently added episodes across all shows

### Discovery
- `POST /api/discover` - Manual discovery trigger (returns immediately, runs in background)

## Data Flow

### Server Operation
1. **Server Startup**: Initialize database → run initial discovery → start scheduler → listen for requests
2. **Periodic Discovery**: Runs automatically every hour at minute 0 via cron scheduler
3. **API Requests**: Real-time database queries with formatted JSON responses
4. **Manual Discovery**: POST to /api/discover triggers immediate background discovery

### Discovery Process
1. **Discovery Phase**: UDP broadcast → HTTP fallback → network scanning → device validation
2. **Storage Detection**: Check multiple endpoints to identify DVR-capable devices  
3. **Content Retrieval**: Series list → individual episode details → metadata parsing
4. **Database Sync**: Upsert devices/series/episodes with conflict resolution

## Protocol Implementation

The application implements the complete HDHomeRun discovery and content access protocols. Refer to `HDHOMERUN_PROTOCOL.md` for detailed protocol documentation including packet formats, API endpoints, and implementation examples.

## Database Storage

SQLite database (`hdhomerun.db`) automatically created on first run. Schema includes:
- Device tracking with capability detection
- Series metadata with automatic statistics  
- Episode details with playback state tracking
- Views and triggers for data integrity

The database enables offline content browsing and provides a foundation for building more advanced DVR management features.