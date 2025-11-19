const express = require('express');
const cors = require('cors');
const cron = require('node-cron');
const path = require('path');
const fs = require('fs');
const axios = require('axios');
const HDHomeRunDiscovery = require('./discovery');
const HDHomeRunDVR = require('./dvr');
const HDHomeRunDatabase = require('./database');
const HLSStreamManager = require('./hls-stream');

class HDHomeRunServer {
  constructor(options = {}) {
    this.app = express();
    this.host = options.host || '127.0.0.1';
    this.port = options.port || 3000;
    this.verbose = options.verbose || false;
    this.database = new HDHomeRunDatabase();
    this.hlsManager = new HLSStreamManager({ verbose: this.verbose });
    this.isDiscovering = false;
    this.lastDiscovery = null;

    this.setupMiddleware();
    this.setupRoutes();
  }

  log(message) {
    const timestamp = new Date().toISOString();
    console.log(`[${timestamp}] ${message}`);
  }

  debug(message) {
    if (this.verbose) {
      const timestamp = new Date().toISOString();
      console.log(`[${timestamp}] [DEBUG] ${message}`);
    }
  }

  formatEpisodeWithHLS(episode, req) {
    const baseUrl = `${req.protocol}://${req.get('host')}`;
    const hlsUrl = `${baseUrl}/api/stream/${episode.id}/playlist.m3u8`;

    return {
      ...episode,
      source_url: episode.play_url,  // Keep original HDHomeRun URL
      play_url: hlsUrl                // Replace with HLS proxy URL
    };
  }

  async relayProgressToHDHomeRun(cmdUrl, position, watched) {
    // Attempt to relay progress to HDHomeRun's CmdURL endpoint
    // This is experimental as the resume/progress API is not officially documented

    try {
      this.debug(`Attempting to relay progress to HDHomeRun: ${cmdUrl}`);

      // Try sending progress as form data (common for POST endpoints)
      const formData = new URLSearchParams();
      formData.append('position', position.toString());
      formData.append('watched', watched ? '1' : '0');
      formData.append('resume', position.toString());

      const response = await axios.post(cmdUrl, formData, {
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded'
        },
        timeout: 5000
      });

      this.debug(`HDHomeRun progress relay response: ${response.status}`);
      return response.data;
    } catch (error) {
      // Don't throw - this is best-effort since API isn't documented
      this.debug(`HDHomeRun progress relay failed (expected): ${error.message}`);
      return null;
    }
  }

  setupMiddleware() {
    this.app.use(cors());
    this.app.use(express.json());
    
    // Request logging
    this.app.use((req, res, next) => {
      this.debug(`${req.method} ${req.path} - ${req.ip}`);
      next();
    });
  }

  setupRoutes() {
    // Health check endpoint
    this.app.get('/health', (req, res) => {
      res.json({
        status: 'ok',
        timestamp: new Date().toISOString(),
        uptime: process.uptime(),
        lastDiscovery: this.lastDiscovery,
        isDiscovering: this.isDiscovering
      });
    });

    // API info endpoint
    this.app.get('/api/info', async (req, res) => {
      try {
        const stats = await this.database.getApiStats();
        res.json({
          ...stats,
          lastDiscovery: this.lastDiscovery,
          isDiscovering: this.isDiscovering,
          serverStarted: new Date().toISOString()
        });
      } catch (error) {
        this.log(`Error getting API info: ${error.message}`);
        res.status(500).json({ error: 'Failed to get API information' });
      }
    });

    // Get all shows/series
    this.app.get('/api/shows', async (req, res) => {
      try {
        const { search, category, limit } = req.query;
        let series;
        
        if (search) {
          series = await this.database.searchSeries(search);
        } else {
          series = await this.database.getAllSeries();
        }

        // Filter by category if specified
        if (category) {
          series = series.filter(s => s.category && s.category.toLowerCase().includes(category.toLowerCase()));
        }

        // Limit results if specified
        if (limit && !isNaN(parseInt(limit))) {
          series = series.slice(0, parseInt(limit));
        }

        // Format timestamps and durations
        const formattedSeries = series.map(s => ({
          ...s,
          duration_hours: Math.round((s.total_duration || 0) / 3600),
          first_recorded: s.first_recorded ? new Date(s.first_recorded * 1000).toISOString() : null,
          last_recorded: s.last_recorded ? new Date(s.last_recorded * 1000).toISOString() : null
        }));

        res.json({
          shows: formattedSeries,
          count: formattedSeries.length,
          filters: { search, category, limit }
        });
      } catch (error) {
        this.log(`Error getting shows: ${error.message}`);
        res.status(500).json({ error: 'Failed to retrieve shows' });
      }
    });

    // Get specific show by ID
    this.app.get('/api/shows/:id', async (req, res) => {
      try {
        const { id } = req.params;
        const series = await this.database.getSeriesById(id);
        
        if (!series) {
          return res.status(404).json({ error: 'Show not found' });
        }

        // Format the series data
        const formattedSeries = {
          ...series,
          duration_hours: Math.round((series.total_duration || 0) / 3600),
          first_recorded: series.first_recorded ? new Date(series.first_recorded * 1000).toISOString() : null,
          last_recorded: series.last_recorded ? new Date(series.last_recorded * 1000).toISOString() : null
        };

        res.json({ show: formattedSeries });
      } catch (error) {
        this.log(`Error getting show ${req.params.id}: ${error.message}`);
        res.status(500).json({ error: 'Failed to retrieve show' });
      }
    });

    // Get episodes for a specific show
    this.app.get('/api/shows/:id/episodes', async (req, res) => {
      try {
        const { id } = req.params;
        const { limit, watched, season } = req.query;
        
        // First verify the show exists
        const series = await this.database.getSeriesById(id);
        if (!series) {
          return res.status(404).json({ error: 'Show not found' });
        }

        let episodes = await this.database.getEpisodesBySeriesId(id);

        // Filter by watched status if specified
        if (watched !== undefined) {
          const watchedFilter = watched.toLowerCase() === 'true';
          episodes = episodes.filter(e => !!e.watched === watchedFilter);
        }

        // Filter by season if specified
        if (season && !isNaN(parseInt(season))) {
          episodes = episodes.filter(e => e.season_number === parseInt(season));
        }

        // Limit results if specified
        if (limit && !isNaN(parseInt(limit))) {
          episodes = episodes.slice(0, parseInt(limit));
        }

        // Format episode data
        const formattedEpisodes = episodes.map(e => {
          const episode = this.formatEpisodeWithHLS(e, req);
          return {
            ...episode,
            start_time: new Date(e.start_time * 1000).toISOString(),
            end_time: new Date(e.end_time * 1000).toISOString(),
            original_airdate: e.original_airdate ? new Date(e.original_airdate * 1000).toISOString() : null,
            duration_minutes: Math.round((e.duration || 0) / 60),
            resume_minutes: Math.round((e.resume_position || 0) / 60)
          };
        });

        res.json({
          episodes: formattedEpisodes,
          count: formattedEpisodes.length,
          show: {
            id: series.id,
            series_id: series.series_id,
            title: series.title
          },
          filters: { limit, watched, season }
        });
      } catch (error) {
        this.log(`Error getting episodes for show ${req.params.id}: ${error.message}`);
        res.status(500).json({ error: 'Failed to retrieve episodes' });
      }
    });

    // Get recent episodes across all shows
    this.app.get('/api/episodes/recent', async (req, res) => {
      try {
        const { limit = 20 } = req.query;
        const episodes = await this.database.getRecentEpisodes(parseInt(limit));

        const formattedEpisodes = episodes.map(e => {
          const episode = this.formatEpisodeWithHLS(e, req);
          return {
            ...episode,
            start_time: new Date(e.start_time * 1000).toISOString(),
            end_time: new Date(e.end_time * 1000).toISOString(),
            duration_minutes: Math.round((e.duration || 0) / 60),
            resume_minutes: Math.round((e.resume_position || 0) / 60)
          };
        });

        res.json({
          episodes: formattedEpisodes,
          count: formattedEpisodes.length,
          limit: parseInt(limit)
        });
      } catch (error) {
        this.log(`Error getting recent episodes: ${error.message}`);
        res.status(500).json({ error: 'Failed to retrieve recent episodes' });
      }
    });

    // Get specific episode by ID
    this.app.get('/api/episodes/:id', async (req, res) => {
      try {
        const { id } = req.params;
        const episode = await this.database.getEpisodeById(id);

        if (!episode) {
          return res.status(404).json({ error: 'Episode not found' });
        }

        const formattedEpisode = this.formatEpisodeWithHLS(episode, req);

        res.json({
          episode: {
            ...formattedEpisode,
            start_time: new Date(episode.start_time * 1000).toISOString(),
            end_time: new Date(episode.end_time * 1000).toISOString(),
            original_airdate: episode.original_airdate ? new Date(episode.original_airdate * 1000).toISOString() : null,
            duration_minutes: Math.round((episode.duration || 0) / 60),
            resume_minutes: Math.round((episode.resume_position || 0) / 60)
          }
        });
      } catch (error) {
        this.log(`Error getting episode ${req.params.id}: ${error.message}`);
        res.status(500).json({ error: 'Failed to retrieve episode' });
      }
    });

    // Update episode playback progress
    this.app.put('/api/episodes/:id/progress', async (req, res) => {
      try {
        const { id } = req.params;
        const { position, watched } = req.body;

        // Validate input
        if (position === undefined || watched === undefined) {
          return res.status(400).json({
            error: 'Missing required fields',
            required: { position: 'number (seconds)', watched: 'boolean (0 or 1)' }
          });
        }

        if (typeof position !== 'number' || position < 0) {
          return res.status(400).json({
            error: 'Invalid position',
            message: 'Position must be a non-negative number in seconds'
          });
        }

        // Get episode to check if it exists and get CmdURL
        const episode = await this.database.getEpisodeById(id);
        if (!episode) {
          return res.status(404).json({ error: 'Episode not found' });
        }

        // Update progress in local database
        const updatedEpisode = await this.database.updateEpisodeProgress(id, position, watched);

        this.debug(`Updated progress for episode ${id}: position=${position}s, watched=${watched}`);

        // Attempt to relay progress to HDHomeRun (experimental)
        // Note: This may not work as the API isn't officially documented
        if (episode.cmd_url) {
          this.relayProgressToHDHomeRun(episode.cmd_url, position, watched).catch(error => {
            this.debug(`Failed to relay progress to HDHomeRun: ${error.message}`);
          });
        }

        const formattedEpisode = this.formatEpisodeWithHLS(updatedEpisode, req);

        res.json({
          success: true,
          episode: {
            ...formattedEpisode,
            start_time: new Date(updatedEpisode.start_time * 1000).toISOString(),
            end_time: new Date(updatedEpisode.end_time * 1000).toISOString(),
            duration_minutes: Math.round((updatedEpisode.duration || 0) / 60),
            resume_minutes: Math.round((updatedEpisode.resume_position || 0) / 60)
          }
        });
      } catch (error) {
        this.log(`Error updating progress for episode ${req.params.id}: ${error.message}`);
        res.status(500).json({ error: 'Failed to update progress' });
      }
    });

    // Manual discovery trigger
    this.app.post('/api/discover', async (req, res) => {
      if (this.isDiscovering) {
        return res.status(429).json({
          error: 'Discovery already in progress',
          isDiscovering: true
        });
      }

      try {
        // Start discovery in background
        this.runDiscovery().catch(error => {
          this.log(`Background discovery failed: ${error.message}`);
        });

        res.json({
          message: 'Discovery started',
          isDiscovering: true,
          timestamp: new Date().toISOString()
        });
      } catch (error) {
        this.log(`Error starting discovery: ${error.message}`);
        res.status(500).json({ error: 'Failed to start discovery' });
      }
    });

    // HLS Streaming endpoints

    // Get HLS playlist for an episode
    this.app.get('/api/stream/:episodeId/playlist.m3u8', async (req, res) => {
      try {
        const { episodeId } = req.params;

        // Get episode from database
        const episode = await this.database.getEpisodeById(episodeId);

        if (!episode) {
          return res.status(404).json({ error: 'Episode not found' });
        }

        if (!episode.source_url && !episode.play_url) {
          return res.status(400).json({ error: 'Episode has no playback URL' });
        }

        // Use source_url (original HDHomeRun URL) for transcoding
        const sourceUrl = episode.source_url || episode.play_url;

        this.debug(`HLS playlist requested for episode ${episodeId}: ${episode.title}`);

        // Start transcoding (or reuse existing transcode)
        const outputDir = await this.hlsManager.startTranscode(episodeId, sourceUrl);
        const playlistPath = path.join(outputDir, 'stream.m3u8');

        // Read and serve the playlist
        const playlist = fs.readFileSync(playlistPath, 'utf8');

        res.set({
          'Content-Type': 'application/vnd.apple.mpegurl',
          'Cache-Control': 'no-cache',
          'Access-Control-Allow-Origin': '*'
        });

        res.send(playlist);
      } catch (error) {
        this.log(`Error serving HLS playlist: ${error.message}`);
        res.status(500).json({ error: 'Failed to generate HLS stream', details: error.message });
      }
    });

    // Serve HLS segments
    this.app.get('/api/stream/:episodeId/:filename', async (req, res) => {
      try {
        const { episodeId, filename } = req.params;

        // Validate filename to prevent directory traversal
        if (filename.includes('..') || filename.includes('/')) {
          return res.status(400).json({ error: 'Invalid filename' });
        }

        const streamDir = this.hlsManager.getStreamDir(episodeId);
        const filePath = path.join(streamDir, filename);

        // Check if file exists - wait a bit if transcode is in progress
        const status = this.hlsManager.getTranscodeStatus(episodeId);

        if (status.state === 'transcoding') {
          // Transcode in progress - wait briefly for segment to appear
          let attempts = 0;
          while (attempts < 10) {
            if (fs.existsSync(filePath)) {
              break;
            }
            await new Promise(resolve => setTimeout(resolve, 500));
            attempts++;
          }
        }

        // Check if file exists
        if (!fs.existsSync(filePath)) {
          return res.status(404).json({
            error: 'Segment not found',
            transcodeState: status.state
          });
        }

        this.debug(`Serving segment: ${filename} for episode ${episodeId}`);

        // Serve the file
        res.set({
          'Content-Type': filename.endsWith('.m3u8') ? 'application/vnd.apple.mpegurl' : 'video/mp2t',
          'Cache-Control': 'public, max-age=86400', // Cache for 24 hours
          'Access-Control-Allow-Origin': '*'
        });

        const stream = fs.createReadStream(filePath);
        stream.pipe(res);

        stream.on('error', (error) => {
          this.log(`Error streaming segment ${filename}: ${error.message}`);
          if (!res.headersSent) {
            res.status(500).json({ error: 'Failed to stream segment' });
          }
        });
      } catch (error) {
        this.log(`Error serving HLS segment: ${error.message}`);
        if (!res.headersSent) {
          res.status(500).json({ error: 'Failed to serve segment' });
        }
      }
    });

    // Get transcode status for an episode
    this.app.get('/api/stream/:episodeId/status', async (req, res) => {
      try {
        const { episodeId } = req.params;
        const status = this.hlsManager.getTranscodeStatus(episodeId);

        res.json({
          episodeId,
          ...status
        });
      } catch (error) {
        this.log(`Error getting transcode status: ${error.message}`);
        res.status(500).json({ error: 'Failed to get transcode status' });
      }
    });

    // 404 handler
    this.app.use('*', (req, res) => {
      res.status(404).json({
        error: 'Endpoint not found',
        path: req.path,
        availableEndpoints: [
          'GET /health',
          'GET /api/info',
          'GET /api/shows',
          'GET /api/shows/:id',
          'GET /api/shows/:id/episodes',
          'GET /api/episodes/recent',
          'GET /api/episodes/:id',
          'PUT /api/episodes/:id/progress',
          'POST /api/discover',
          'GET /api/stream/:episodeId/playlist.m3u8',
          'GET /api/stream/:episodeId/:filename',
          'GET /api/stream/:episodeId/status'
        ]
      });
    });

    // Error handler
    this.app.use((error, req, res, next) => {
      this.log(`Unhandled error: ${error.message}`);
      res.status(500).json({ error: 'Internal server error' });
    });
  }

  async runDiscovery() {
    if (this.isDiscovering) {
      this.debug('Discovery already in progress, skipping');
      return;
    }

    this.isDiscovering = true;
    this.log('Starting HDHomeRun device discovery...');
    
    try {
      const discovery = new HDHomeRunDiscovery(this.verbose);
      const devices = await discovery.discoverDevices();
      
      if (devices.length === 0) {
        this.log('No HDHomeRun devices found');
        return;
      }

      this.log(`Found ${devices.length} HDHomeRun device(s)`);

      // Check for DVR storage devices
      const storageDevices = await discovery.discoverStorageDevices();
      
      if (storageDevices.length === 0) {
        this.log('No HDHomeRun DVR storage devices found');
        return;
      }

      this.log(`Found ${storageDevices.length} DVR storage device(s)`);

      // Process each storage device
      for (const device of storageDevices) {
        this.log(`Processing device: ${device.FriendlyName || device.ip}`);
        
        const dvr = new HDHomeRunDVR(device);
        
        // Get storage info
        const storageInfo = await dvr.getStorageInfo();
        if (storageInfo.FreeSpace !== undefined) {
          device.TotalSpace = storageInfo.TotalSpace;
          device.FreeSpace = storageInfo.FreeSpace;
        }

        // Get recorded shows
        const shows = await dvr.getRecordedShows();
        this.log(`Found ${shows.length} series on ${device.FriendlyName}`);
        
        // Sync to database
        await this.database.syncDeviceData(device, shows);
      }

      this.lastDiscovery = new Date().toISOString();
      this.log(`Discovery completed successfully at ${this.lastDiscovery}`);

    } catch (error) {
      this.log(`Discovery failed: ${error.message}`);
    } finally {
      this.isDiscovering = false;
    }
  }

  setupScheduler() {
    // Run discovery every hour at minute 0
    cron.schedule('0 * * * *', () => {
      this.log('Running scheduled discovery...');
      this.runDiscovery().catch(error => {
        this.log(`Scheduled discovery failed: ${error.message}`);
      });
    });

    this.log('Scheduled discovery every hour (at minute 0)');
  }

  async start() {
    try {
      // Initialize database
      this.log('Initializing database...');
      await this.database.initialize();

      // Initialize HLS stream manager
      this.log('Initializing HLS stream manager...');
      await this.hlsManager.initialize();

      // Run initial discovery
      this.log('Running initial discovery...');
      await this.runDiscovery();

      // Setup scheduled discovery
      this.setupScheduler();

      // Start server
	this.app.listen(this.port, this.host, () => {
        this.log(`HDHomeRun DVR API server running on http://${this.host}:${this.port}`);
        this.log('Available endpoints:');
        this.log('  GET /health - Health check');
        this.log('  GET /api/info - API statistics');
        this.log('  GET /api/shows - All shows/series');
        this.log('  GET /api/shows/:id - Specific show');
        this.log('  GET /api/shows/:id/episodes - Episodes for a show');
        this.log('  GET /api/episodes/recent - Recent episodes');
        this.log('  GET /api/episodes/:id - Get specific episode');
        this.log('  PUT /api/episodes/:id/progress - Update watch progress');
        this.log('  POST /api/discover - Manual discovery trigger');
        this.log('  GET /api/stream/:episodeId/playlist.m3u8 - HLS stream');
        this.log('  GET /api/stream/:episodeId/status - Transcode status');
      });
    } catch (error) {
      this.log(`Failed to start server: ${error.message}`);
      process.exit(1);
    }
  }

  async stop() {
    this.log('Shutting down server...');
    await this.hlsManager.shutdown();
    await this.database.close();
  }
}

// Handle startup
if (require.main === module) {
  const verbose = process.argv.includes('--verbose') || process.argv.includes('-v');
  const host = process.env.HOST || '127.0.0.1';
  const port = process.env.PORT || 3000;
  
  const server = new HDHomeRunServer({ host, port, verbose });
  
  // Handle graceful shutdown
  process.on('SIGTERM', async () => {
    await server.stop();
    process.exit(0);
  });
  
  process.on('SIGINT', async () => {
    await server.stop();
    process.exit(0);
  });
  
  server.start().catch(error => {
    console.error('Failed to start server:', error);
    process.exit(1);
  });
}

module.exports = HDHomeRunServer;
