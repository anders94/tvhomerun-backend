const express = require('express');
const cors = require('cors');
const cron = require('node-cron');
const path = require('path');
const fs = require('fs');
const axios = require('axios');
const db = require('asynqlite');
const HDHomeRunDiscovery = require('./discovery');
const HDHomeRunDVR = require('./dvr');
const HDHomeRunDatabase = require('./database');
const HLSStreamManager = require('./hls-stream');
const GuideManager = require('./guide');
const RecordingRulesManager = require('./recording-rules');
const TunerManager = require('./live-tv');

class HDHomeRunServer {
  constructor(options = {}) {
    this.app = express();
    this.host = options.host || '127.0.0.1';
    this.port = options.port || 3000;
    this.verbose = options.verbose || false;
    this.preCache = options.preCache || false;
    this.database = new HDHomeRunDatabase();
    this.hlsManager = new HLSStreamManager({ verbose: this.verbose, cacheDir: process.env.HLS_CACHE_DIR });
    // Completed caches of recordings still on the device are re-creatable and are
    // dropped after this many days without being played (0 = keep forever).
    // Caches of recordings that are gone from the device are never aged out.
    const maxAgeDays = parseInt(process.env.HLS_CACHE_MAX_AGE_DAYS ?? '30', 10);
    this.hlsCacheMaxAgeMs = Number.isNaN(maxAgeDays) ? 30 * 86400000 : maxAgeDays * 86400000;
    this.isDiscovering = false;
    this.lastDiscovery = null;
    this.isBulkCaching = false;

    // Live TV configuration
    this.liveTVEnabled = options.liveTV !== false; // Enabled by default
    this.liveTVConfig = {
      enabled: this.liveTVEnabled,
      cacheDir: 'live-cache',
      bufferMinutes: 60,
      segmentDuration: 6,
      clientHeartbeat: 30,
      missedHeartbeats: 2,
      tunerCooldown: 300,
      pruneInterval: 30,
      maxViewersPerTuner: 10,
      ...options.liveTVConfig
    };
    this.tunerManager = null;

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

  getDirectorySize(dirPath) {
    // Calculate total size of directory and all its contents
    // Returns size in bytes, or 0 if directory doesn't exist
    try {
      if (!fs.existsSync(dirPath)) {
        return 0;
      }

      let totalSize = 0;
      const files = fs.readdirSync(dirPath);

      for (const file of files) {
        const filePath = path.join(dirPath, file);
        const stats = fs.statSync(filePath);

        if (stats.isDirectory()) {
          totalSize += this.getDirectorySize(filePath);
        } else {
          totalSize += stats.size;
        }
      }

      return totalSize;
    } catch (error) {
      this.debug(`Error calculating directory size for ${dirPath}: ${error.message}`);
      return 0;
    }
  }

  formatEpisodeWithHLS(episode, req) {
    const baseUrl = `${req.protocol}://${req.get('host')}`;
    const hlsUrl = `${baseUrl}/api/stream/${episode.id}/playlist.m3u8`;

    // Calculate HLS cache size from filesystem
    const hlsCacheDir = path.join(this.hlsManager.cacheDir, String(episode.id));
    const hlsCacheSize = this.getDirectorySize(hlsCacheDir);
    const cacheState = this.hlsManager.getTranscodeStatus(episode.id).state;
    const onDevice = !episode.device_missing_since;
    const hasLocalCopy = cacheState === 'complete';

    return {
      ...episode,
      hls_cache_bytes: hlsCacheSize,
      hls_cache_state: hasLocalCopy || cacheState === 'transcoding' || cacheState === 'error' ? cacheState : null,
      on_device: onDevice,                  // Device still lists this recording
      local_copy: hasLocalCopy,             // Complete transcode is cached locally
      playable: onDevice || hasLocalCopy,   // False means the recording is gone everywhere
      source_url: episode.play_url,  // Keep original HDHomeRun URL
      play_url: hlsUrl                // Replace with HLS proxy URL
    };
  }

  async verifyOnDevice(episode) {
    // Ask the device whether a recording flagged as missing has come back
    // (e.g. a drive was remounted). Clears the flag if so. Returns true only on a
    // confirmed "present"; errors are treated as still missing here because the
    // caller already has a flag saying so.
    if (!episode.cmd_url) return false;
    try {
      const { origin } = new URL(episode.cmd_url);
      const response = await axios.get(`${origin}/recorded_files.json`, {
        params: { SeriesID: episode.series_series_id },
        timeout: 5000
      });
      const recordingId = HDHomeRunDVR.recordingIdFromUrl(episode.cmd_url);
      const present = Array.isArray(response.data) &&
        response.data.some(recording => HDHomeRunDVR.recordingIdFromUrl(recording.CmdURL) === recordingId);
      if (present) {
        this.log(`Episode ${episode.id} is back on the device, clearing missing flag`);
        await this.database.clearEpisodeMissing(episode.id);
      }
      return present;
    } catch (error) {
      this.debug(`Could not re-check episode ${episode.id} on device: ${error.message}`);
      return false;
    }
  }

  async relayProgressToHDHomeRun(cmdUrl, position, watched) {
    // Relay progress to HDHomeRun's CmdURL endpoint
    // Format: POST /recorded/cmd?id={id}&cmd=set&Resume={position}

    try {
      this.log(`Attempting to relay progress to HDHomeRun:`);
      this.log(`  URL: ${cmdUrl}`);
      this.log(`  Position: ${position}`);
      this.log(`  Watched: ${watched}`);

      // HDHomeRun uses cmd=set with Resume as a query parameter
      // Special value 4294967295 (max uint32) indicates "watched"
      const resumeValue = watched ? '4294967295' : position.toString();
      const url = `${cmdUrl}&cmd=set&Resume=${resumeValue}`;

      this.log(`  Request URL: ${url}`);

      const response = await axios.post(url, null, {
        timeout: 5000
      });

      this.log(`✓ Progress synced to HDHomeRun device (Resume: ${resumeValue})`);
      return { success: true, status: response.status };
    } catch (error) {
      this.log(`✗ HDHomeRun device sync failed:`);
      if (error.response) {
        this.log(`  Status: ${error.response.status} ${error.response.statusText}`);
        this.log(`  Response data: ${JSON.stringify(error.response.data)}`);
      } else {
        this.log(`  Error: ${error.message}`);
      }
      this.log(`⚠️  Warning: Could not sync progress to HDHomeRun device: ${error.message}`);
      return { success: false, error: error.message };
    }
  }

  async deleteRecordingFromHDHomeRun(cmdUrl, rerecord = false) {
    // Delete recording from HDHomeRun device
    // Format: POST /recorded/cmd?id={id}&cmd=delete&rerecord={0|1}

    try {
      this.log(`Attempting to delete recording from HDHomeRun:`);
      this.log(`  URL: ${cmdUrl}`);
      this.log(`  Rerecord: ${rerecord}`);

      const url = `${cmdUrl}&cmd=delete&rerecord=${rerecord ? '1' : '0'}`;
      this.log(`  Request URL: ${url}`);

      const response = await axios.post(url, null, {
        timeout: 5000
      });

      this.log(`✓ Recording deleted from HDHomeRun device`);
      return { success: true, status: response.status };
    } catch (error) {
      this.log(`✗ HDHomeRun device deletion failed:`);
      if (error.response) {
        this.log(`  Status: ${error.response.status} ${error.response.statusText}`);
        this.log(`  Response data: ${JSON.stringify(error.response.data)}`);
      } else {
        this.log(`  Error: ${error.message}`);
      }
      throw new Error(`Failed to delete recording from device: ${error.message}`);
    }
  }

  async isRecordingOnDevice(episode) {
    // Check whether the device still lists this recording. Errs on the side of
    // "still there" if the device can't be queried.
    try {
      const { origin } = new URL(episode.cmd_url);
      const response = await axios.get(`${origin}/recorded_files.json`, {
        params: { SeriesID: episode.series_series_id },
        timeout: 5000
      });
      if (!Array.isArray(response.data)) {
        return true;
      }
      const recordingId = HDHomeRunDVR.recordingIdFromUrl(episode.cmd_url);
      return response.data.some(recording => HDHomeRunDVR.recordingIdFromUrl(recording.CmdURL) === recordingId);
    } catch (error) {
      this.log(`Could not verify recording on device: ${error.message}`);
      return true;
    }
  }

  setupMiddleware() {
    this.app.use(cors());
    this.app.use(express.json());

    // Request logging (always enabled)
    this.app.use((req, res, next) => {
      const timestamp = new Date().toISOString();
      console.log(`[${timestamp}] ${req.method} ${req.path} - ${req.ip}`);
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
        isDiscovering: this.isDiscovering,
        preCache: this.preCache,
        isBulkCaching: this.isBulkCaching
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
          preCache: this.preCache,
          isBulkCaching: this.isBulkCaching,
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

        // Attempt to relay progress to HDHomeRun
        // Note: This uses undocumented APIs and may not work on all devices/firmware versions
        let deviceSyncResult = null;
        if (episode.device_missing_since) {
          this.debug(`Episode ${id} is not on the device, skipping device sync`);
          deviceSyncResult = { success: false, error: 'Recording is not on the device' };
        } else if (episode.cmd_url) {
          deviceSyncResult = await this.relayProgressToHDHomeRun(episode.cmd_url, position, watched);
        } else {
          this.debug('Episode has no cmd_url, skipping device sync');
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
          },
          deviceSync: deviceSyncResult ? {
            attempted: true,
            success: deviceSyncResult.success,
            error: deviceSyncResult.error || null
          } : {
            attempted: false,
            success: false,
            error: 'Episode has no command URL'
          }
        });
      } catch (error) {
        this.log(`Error updating progress for episode ${req.params.id}: ${error.message}`);
        res.status(500).json({ error: 'Failed to update progress' });
      }
    });

    // Delete episode
    this.app.delete('/api/episodes/:id', async (req, res) => {
      try {
        const { id } = req.params;
        const rerecord = req.query.rerecord === 'true';
        const force = req.query.force === 'true';

        // Get episode to check if it exists and get cmd_url
        const episode = await this.database.getEpisodeById(id);
        if (!episode) {
          return res.status(404).json({ error: 'Episode not found' });
        }

        this.log(`Deleting episode ${id}: ${episode.series_title} - ${episode.episode_title}`);

        // Step 1: Delete from HDHomeRun device. A local delete must always be
        // mirrored on the device, so this only proceeds past a failure when the
        // device confirms the recording is already gone (or force=true).
        let deviceDeletionResult = { attempted: false, success: false };
        if (episode.cmd_url) {
          let onDevice = true;
          if (episode.device_missing_since) {
            // Flagged missing by discovery - re-check in case it came back
            onDevice = await this.verifyOnDevice(episode);
          }

          if (onDevice) {
            try {
              deviceDeletionResult = { attempted: true, ...(await this.deleteRecordingFromHDHomeRun(episode.cmd_url, rerecord)) };
              this.log(`✓ Episode deleted from HDHomeRun device`);
            } catch (error) {
              if (await this.isRecordingOnDevice(episode)) {
                if (!force) {
                  this.log(`✗ Failed to delete from device: ${error.message}`);
                  return res.status(500).json({
                    error: 'Failed to delete recording from HDHomeRun device',
                    details: error.message,
                    hint: 'Retry with ?force=true to remove the local copy anyway',
                    deviceDeletion: { attempted: true, success: false, error: error.message }
                  });
                }
                this.log(`⚠️  Device deletion failed but force=true, removing local copy only`);
                deviceDeletionResult = { attempted: true, success: false, forced: true, error: error.message };
              } else {
                // Already deleted on the device (e.g. from another client)
                this.log(`⚠️  Recording no longer on device, removing local copy only`);
                deviceDeletionResult = { attempted: true, success: true, alreadyDeleted: true };
              }
            }
          } else {
            this.log(`⚠️  Recording is not on the device (missing since ${episode.device_missing_since}), removing local copy only`);
            deviceDeletionResult = { attempted: false, success: true, alreadyDeleted: true };
          }
        } else {
          this.log(`⚠️  Episode has no cmd_url, skipping device deletion`);
        }

        // Step 2: Delete HLS cache (kills any running transcode and drops the job)
        const hlsCacheDir = this.hlsManager.getStreamDir(id);
        let hlsDeletionResult = { attempted: false, success: false };

        if (fs.existsSync(hlsCacheDir)) {
          this.log(`Deleting HLS cache directory: ${hlsCacheDir}`);
          await this.hlsManager.deleteTranscode(id);
          if (fs.existsSync(hlsCacheDir)) {
            this.log(`✗ Failed to delete HLS cache: directory still exists`);
            hlsDeletionResult = { attempted: true, success: false, error: 'Directory still exists' };
          } else {
            hlsDeletionResult = { attempted: true, success: true };
            this.log(`✓ HLS cache deleted`);
          }
        } else {
          this.hlsManager.transcodeJobs.delete(String(id));
          this.debug(`HLS cache directory does not exist: ${hlsCacheDir}`);
        }

        // Step 3: Delete from local database
        try {
          await this.database.deleteEpisode(id);
          this.log(`✓ Episode deleted from local database`);
        } catch (error) {
          this.log(`✗ Failed to delete from database: ${error.message}`);
          return res.status(500).json({
            error: 'Failed to delete episode from database',
            details: error.message,
            deviceDeletion: deviceDeletionResult,
            hlsDeletion: hlsDeletionResult
          });
        }

        res.json({
          success: true,
          message: 'Episode deleted successfully',
          episode: {
            id: episode.id,
            series_title: episode.series_title,
            episode_title: episode.episode_title
          },
          deviceDeletion: deviceDeletionResult,
          hlsDeletion: hlsDeletionResult
        });
      } catch (error) {
        this.log(`Error deleting episode ${req.params.id}: ${error.message}`);
        res.status(500).json({ error: 'Failed to delete episode' });
      }
    });

    // HLS cache maintenance view: what's on disk, what's only on disk, what's orphaned
    this.app.get('/api/cache', async (req, res) => {
      try {
        const report = await this.buildCacheReport();
        res.json(report);
      } catch (error) {
        this.log(`Error building cache report: ${error.message}`);
        res.status(500).json({ error: 'Failed to build cache report' });
      }
    });

    // Remove a cache directory. Refuses to remove the only copy of a recording -
    // that has to go through DELETE /api/episodes/:id so the intent is explicit.
    this.app.delete('/api/cache/:episodeId', async (req, res) => {
      try {
        const { episodeId } = req.params;
        if (!/^\d+$/.test(episodeId)) {
          return res.status(400).json({ error: 'Invalid episode id' });
        }

        const cacheDir = this.hlsManager.getStreamDir(episodeId);
        if (!fs.existsSync(cacheDir)) {
          return res.status(404).json({ error: 'No cache for this episode' });
        }

        const episode = await this.database.getEpisodeById(episodeId);
        if (episode && episode.device_missing_since) {
          return res.status(409).json({
            error: 'This cache is the only copy of a recording that is no longer on the device',
            hint: `Use DELETE /api/episodes/${episode.id} to delete the recording`
          });
        }

        this.log(`Removing cache for episode ${episodeId} (${episode ? 'still on device' : 'orphan, no database record'})`);
        await this.hlsManager.deleteTranscode(episodeId);
        res.json({ success: true, episodeId: parseInt(episodeId, 10), orphan: !episode });
      } catch (error) {
        this.log(`Error removing cache ${req.params.episodeId}: ${error.message}`);
        res.status(500).json({ error: 'Failed to remove cache' });
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

    // Program Guide endpoints

    // Get program guide (cached, auto-refreshes if stale)
    this.app.get('/api/guide', async (req, res) => {
      try {
        const { forceRefresh = false } = req.query;

        const guide = await GuideManager.getGuide({
          forceRefresh: forceRefresh === 'true'
        });

        res.json({
          guide,
          channels: guide.length,
          timestamp: new Date().toISOString()
        });
      } catch (error) {
        this.log(`Error getting guide: ${error.message}`);
        res.status(500).json({
          error: 'Failed to retrieve program guide',
          details: error.message
        });
      }
    });

    // Search program guide
    this.app.get('/api/guide/search', async (req, res) => {
      try {
        const { q, query, channel, limit = 50 } = req.query;
        const searchQuery = q || query;

        if (!searchQuery) {
          return res.status(400).json({
            error: 'Missing search query',
            message: 'Provide search query using ?q= or ?query= parameter'
          });
        }

        const results = await GuideManager.searchGuide(searchQuery, {
          channel,
          limit: parseInt(limit)
        });

        res.json({
          results,
          count: results.length,
          query: searchQuery,
          filters: { channel, limit }
        });
      } catch (error) {
        this.log(`Error searching guide: ${error.message}`);
        res.status(500).json({
          error: 'Failed to search program guide',
          details: error.message
        });
      }
    });

    // Get what's on now
    this.app.get('/api/guide/now', async (req, res) => {
      try {
        const currentPrograms = await GuideManager.getCurrentPrograms();

        res.json({
          programs: currentPrograms,
          count: currentPrograms.length,
          timestamp: new Date().toISOString()
        });
      } catch (error) {
        this.log(`Error getting current programs: ${error.message}`);
        res.status(500).json({
          error: 'Failed to get current programs',
          details: error.message
        });
      }
    });

    // Recording Rules endpoints

    // List all recording rules
    this.app.get('/api/recording-rules', async (req, res) => {
      try {
        const rules = await RecordingRulesManager.listRules();

        res.json({
          rules,
          count: rules.length,
          timestamp: new Date().toISOString()
        });
      } catch (error) {
        this.log(`Error listing recording rules: ${error.message}`);
        res.status(500).json({
          error: 'Failed to retrieve recording rules',
          details: error.message
        });
      }
    });

    // Create or update recording rule
    this.app.post('/api/recording-rules', async (req, res) => {
      try {
        const {
          SeriesID,
          ChannelOnly,
          TeamOnly,
          RecentOnly,
          AfterOriginalAirdateOnly,
          DateTimeOnly,
          StartPadding,
          EndPadding
        } = req.body;

        // Validate required fields
        if (!SeriesID) {
          return res.status(400).json({
            error: 'Missing required field',
            message: 'SeriesID is required'
          });
        }

        // Build params object
        const params = { SeriesID };
        if (ChannelOnly) params.ChannelOnly = ChannelOnly;
        if (TeamOnly) params.TeamOnly = TeamOnly;
        if (RecentOnly !== undefined) params.RecentOnly = RecentOnly ? 1 : 0;
        if (AfterOriginalAirdateOnly) params.AfterOriginalAirdateOnly = AfterOriginalAirdateOnly;
        if (DateTimeOnly) params.DateTimeOnly = DateTimeOnly;
        if (StartPadding) params.StartPadding = StartPadding;
        if (EndPadding) params.EndPadding = EndPadding;

        this.log(`Creating recording rule for SeriesID: ${SeriesID}`);

        const result = await RecordingRulesManager.createRule(params);

        res.json({
          success: true,
          message: 'Recording rule created',
          params,
          result
        });
      } catch (error) {
        this.log(`Error creating recording rule: ${error.message}`);
        res.status(500).json({
          error: 'Failed to create recording rule',
          details: error.message
        });
      }
    });

    // Delete recording rule
    this.app.delete('/api/recording-rules/:id', async (req, res) => {
      try {
        const { id } = req.params;

        this.log(`Deleting recording rule: ${id}`);

        const result = await RecordingRulesManager.deleteRule(id);

        res.json({
          success: true,
          message: 'Recording rule deleted',
          recordingRuleId: id,
          result
        });
      } catch (error) {
        this.log(`Error deleting recording rule: ${error.message}`);
        res.status(500).json({
          error: 'Failed to delete recording rule',
          details: error.message
        });
      }
    });

    // Change recording rule priority
    this.app.put('/api/recording-rules/:id/priority', async (req, res) => {
      try {
        const { id } = req.params;
        const { afterRecordingRuleId } = req.body;

        if (afterRecordingRuleId === undefined) {
          return res.status(400).json({
            error: 'Missing required field',
            message: 'afterRecordingRuleId is required (use "0" for highest priority)'
          });
        }

        this.log(`Changing priority for recording rule ${id} to after ${afterRecordingRuleId}`);

        const result = await RecordingRulesManager.changePriority(id, afterRecordingRuleId);

        res.json({
          success: true,
          message: 'Recording rule priority updated',
          recordingRuleId: id,
          afterRecordingRuleId,
          result
        });
      } catch (error) {
        this.log(`Error changing recording rule priority: ${error.message}`);
        res.status(500).json({
          error: 'Failed to change recording rule priority',
          details: error.message
        });
      }
    });

    // Get recording rule by ID
    this.app.get('/api/recording-rules/:id', async (req, res) => {
      try {
        const { id } = req.params;

        const rule = await RecordingRulesManager.getRuleById(id);

        if (!rule) {
          return res.status(404).json({ error: 'Recording rule not found' });
        }

        res.json({ rule });
      } catch (error) {
        this.log(`Error getting recording rule: ${error.message}`);
        res.status(500).json({
          error: 'Failed to retrieve recording rule',
          details: error.message
        });
      }
    });

    // Check if series has recording rule
    this.app.get('/api/series/:seriesId/recording-rule', async (req, res) => {
      try {
        const { seriesId } = req.params;

        const hasRule = await RecordingRulesManager.hasRecordingRule(seriesId);
        const rules = await RecordingRulesManager.getRulesBySeriesId(seriesId);

        res.json({
          seriesId,
          hasRecordingRule: hasRule,
          rules
        });
      } catch (error) {
        this.log(`Error checking recording rule: ${error.message}`);
        res.status(500).json({
          error: 'Failed to check recording rule',
          details: error.message
        });
      }
    });

    // Live TV endpoints

    if (this.liveTVEnabled) {
      // Get available channels
      this.app.get('/api/live/channels', async (req, res) => {
        try {
          // Return channel lineup from guide data
          const channels = await db.run(`
            SELECT DISTINCT guide_number, guide_name, affiliate, image_url
            FROM guide_channels
            ORDER BY CAST(guide_number AS REAL)
          `);

          res.json({
            channels,
            count: channels.length,
            timestamp: new Date().toISOString()
          });
        } catch (error) {
          this.log(`Error getting live channels: ${error.message}`);
          res.status(500).json({
            error: 'Failed to retrieve channel lineup',
            details: error.message
          });
        }
      });

      // Start watching a channel
      this.app.post('/api/live/watch', async (req, res) => {
        try {
          const { channelNumber, clientId } = req.body;

          if (!channelNumber || !clientId) {
            return res.status(400).json({
              error: 'Missing required parameters',
              message: 'channelNumber and clientId are required'
            });
          }

          this.log(`[LiveTV] Allocating tuner for channel ${channelNumber}, client ${clientId}`);
          const tunerId = await this.tunerManager.allocateTuner(channelNumber, clientId);

          if (!tunerId) {
            return res.status(503).json({
              error: 'No tuners available',
              message: 'All tuners are currently in use. Please try again later.'
            });
          }

          // Wait for first segment to be ready before responding
          this.log(`[LiveTV] Waiting for first segment to be ready for ${tunerId}`);
          try {
            await this.tunerManager.waitForFirstSegment(tunerId, 20000);
            this.log(`[LiveTV] Stream ready for ${tunerId}`);
          } catch (waitError) {
            this.log(`[LiveTV] Timeout waiting for first segment: ${waitError.message}`);
            // Stream started but first segment not ready yet - still return success
            // Client can retry fetching the playlist
          }

          res.json({
            success: true,
            tunerId,
            playlistUrl: `/api/live/${tunerId}/playlist.m3u8`,
            channelNumber,
            message: 'Stream ready'
          });
        } catch (error) {
          this.log(`Error starting live stream: ${error.message}`);
          res.status(500).json({
            error: 'Failed to start live stream',
            details: error.message
          });
        }
      });

      // Keep-alive heartbeat
      this.app.post('/api/live/heartbeat', async (req, res) => {
        try {
          const { clientId } = req.body;

          if (!clientId) {
            return res.status(400).json({
              error: 'Missing required parameter',
              message: 'clientId is required'
            });
          }

          const success = await this.tunerManager.heartbeat(clientId);

          if (!success) {
            return res.status(404).json({
              error: 'Client not found',
              message: 'No active session found for this client'
            });
          }

          res.json({
            success: true,
            timestamp: new Date().toISOString()
          });
        } catch (error) {
          this.log(`Error updating heartbeat: ${error.message}`);
          res.status(500).json({
            error: 'Failed to update heartbeat',
            details: error.message
          });
        }
      });

      // Stop watching
      this.app.post('/api/live/stop', async (req, res) => {
        try {
          const { clientId } = req.body;

          if (!clientId) {
            return res.status(400).json({
              error: 'Missing required parameter',
              message: 'clientId is required'
            });
          }

          await this.tunerManager.releaseViewer(clientId);

          res.json({
            success: true,
            message: 'Viewer released successfully'
          });
        } catch (error) {
          this.log(`Error stopping live stream: ${error.message}`);
          res.status(500).json({
            error: 'Failed to stop live stream',
            details: error.message
          });
        }
      });

      // Serve HLS playlist
      this.app.get('/api/live/:tunerId/playlist.m3u8', (req, res) => {
        const { tunerId } = req.params;
        const filePath = path.join(this.liveTVConfig.cacheDir, tunerId, 'playlist.m3u8');
        res.sendFile(path.resolve(filePath), (err) => {
          if (err) {
            this.debug(`Error serving playlist for ${tunerId}: ${err.message}`);
            // Only send error response if headers haven't been sent yet
            if (!res.headersSent) {
              res.status(404).json({
                error: 'Playlist not found',
                message: 'Stream may still be starting or has ended'
              });
            }
          }
        });
      });

      // Serve HLS segments
      this.app.get('/api/live/:tunerId/:segment', (req, res) => {
        const { tunerId, segment } = req.params;

        // Only allow .ts files
        if (!segment.endsWith('.ts')) {
          return res.status(400).json({ error: 'Invalid segment file' });
        }

        const filePath = path.join(this.liveTVConfig.cacheDir, tunerId, segment);
        res.sendFile(path.resolve(filePath), (err) => {
          if (err) {
            this.debug(`Error serving segment ${segment} for ${tunerId}: ${err.message}`);
            // Only send error response if headers haven't been sent yet
            if (!res.headersSent) {
              res.status(404).json({ error: 'Segment not found' });
            }
          }
        });
      });

      // Get tuner status (admin endpoint)
      this.app.get('/api/live/tuners', async (req, res) => {
        try {
          const tuners = await this.tunerManager.getTunerStatus();

          res.json({
            tuners,
            count: tuners.length,
            timestamp: new Date().toISOString()
          });
        } catch (error) {
          this.log(`Error getting tuner status: ${error.message}`);
          res.status(500).json({
            error: 'Failed to retrieve tuner status',
            details: error.message
          });
        }
      });
    }

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

        const cached = this.hlsManager.getTranscodeStatus(episodeId).state === 'complete';
        if (cached) {
          await this.hlsManager.touch(episodeId);
        } else if (episode.device_missing_since && !(await this.verifyOnDevice(episode))) {
          // Nothing to transcode from and nothing cached: the recording is gone
          return res.status(410).json({
            error: 'Recording is no longer on the HDHomeRun device and there is no local copy',
            device_missing_since: episode.device_missing_since
          });
        }

        // Prepare metadata for transcode
        const metadata = {
          showName: episode.series_title,
          episodeName: episode.episode_title || episode.title,
          airDate: episode.start_time ? new Date(episode.start_time * 1000).toISOString() : null
        };

        // Start transcoding (or reuse existing transcode)
        const outputDir = await this.hlsManager.startTranscode(episodeId, sourceUrl, false, metadata);
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
          'DELETE /api/episodes/:id',
          'POST /api/discover',
          'GET /api/guide',
          'GET /api/guide/search',
          'GET /api/guide/now',
          'GET /api/recording-rules',
          'POST /api/recording-rules',
          'GET /api/recording-rules/:id',
          'DELETE /api/recording-rules/:id',
          'PUT /api/recording-rules/:id/priority',
          'GET /api/series/:seriesId/recording-rule',
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

  async registerTunersForLiveTV(devices) {
    this.debug('[LiveTV] Registering tuners from discovered devices...');

    for (const device of devices) {
      try {
        // Get tuner status from device
        const statusUrl = `http://${device.ip}/status.json`;
        const response = await axios.get(statusUrl, { timeout: 5000 });
        const tunerStatus = response.data;

        // Register each tuner
        for (const tuner of tunerStatus) {
          if (tuner.Resource && tuner.Resource.startsWith('tuner')) {
            const tunerIndex = parseInt(tuner.Resource.replace('tuner', ''));
            await this.tunerManager.registerTuner(device.DeviceID, device.ip, tunerIndex);
          }
        }

        this.debug(`[LiveTV] Registered ${tunerStatus.length} tuners for device ${device.DeviceID}`);
      } catch (error) {
        this.debug(`[LiveTV] Failed to register tuners for ${device.DeviceID}: ${error.message}`);
      }
    }
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
        
        // Sync to database. Recordings that vanished from the device are flagged,
        // never deleted (only when the device's series list was read successfully,
        // so a network blip can't flag everything).
        await this.database.syncDeviceData(device, shows, {
          reconcile: !dvr.recordedShowsError
        });
      }

      // Recordings on storage devices that didn't show up at all (replaced unit,
      // new DeviceID) are flagged the same way
      await this.database.markUnseenDevicesMissing(storageDevices.map(d => d.DeviceID));

      this.lastDiscovery = new Date().toISOString();
      this.log(`Discovery completed successfully at ${this.lastDiscovery}`);

      await this.maintainHlsCache();

      // Register tuners for live TV
      if (this.liveTVEnabled && this.tunerManager) {
        await this.registerTunersForLiveTV(devices);
      }

      // Start bulk HLS conversion if pre-cache is enabled
      if (this.preCache && !this.isBulkCaching) {
        this.log('Pre-cache enabled, starting bulk HLS conversion...');
        this.startBulkCaching().catch(error => {
          this.log(`Bulk caching failed: ${error.message}`);
        });
      }

    } catch (error) {
      this.log(`Discovery failed: ${error.message}`);
    } finally {
      this.isDiscovering = false;
    }
  }

  async startBulkCaching() {
    if (this.isBulkCaching) {
      this.debug('Bulk caching already in progress');
      return;
    }

    this.isBulkCaching = true;

    try {
      // Get all episodes from database
      this.log('Fetching all episodes from database...');
      const allEpisodes = await this.database.getAllEpisodes();

      if (allEpisodes.length === 0) {
        this.log('No episodes found for bulk caching');
        return;
      }

      // Filter to only episodes recorded in the past month (30 days) that the
      // device still has (there is no source to transcode a missing one from)
      const thirtyDaysAgo = Math.floor(Date.now() / 1000) - (30 * 24 * 60 * 60);
      const recentEpisodes = allEpisodes.filter(episode => {
        // Use start_time for filtering (Unix timestamp in seconds)
        return episode.start_time >= thirtyDaysAgo && !episode.device_missing_since;
      });

      this.log(`Found ${allEpisodes.length} total episodes, ${recentEpisodes.length} recorded in the past month`);

      if (recentEpisodes.length === 0) {
        this.log('No recent episodes found for bulk caching');
        return;
      }

      this.log(`Starting bulk HLS conversion of ${recentEpisodes.length} recent episodes...`);

      // Start bulk conversion (runs in background)
      await this.hlsManager.startBulkConversion(recentEpisodes);

    } catch (error) {
      this.log(`Error during bulk caching: ${error.message}`);
    } finally {
      this.isBulkCaching = false;
    }
  }

  async buildCacheReport() {
    const [cacheDirs, missingEpisodes, onDeviceIds] = await Promise.all([
      this.hlsManager.listCacheDirs(),
      this.database.getMissingEpisodes(),
      this.database.getEpisodeIdsOnDevice()
    ]);
    const missingById = new Map(missingEpisodes.map(e => [String(e.id), e]));

    const orphans = [];      // cache dir, no database record: unreachable through the API
    const preserved = [];    // cache dir for a recording the device no longer has: only copy
    const disposable = [];   // cache dir for a recording still on the device: re-creatable
    for (const entry of cacheDirs) {
      const id = parseInt(entry.episodeId, 10);
      if (missingById.has(entry.episodeId)) {
        preserved.push({ ...entry, episode: missingById.get(entry.episodeId) });
      } else if (onDeviceIds.has(id)) {
        disposable.push(entry);
      } else {
        orphans.push(entry);
      }
    }

    // Recordings gone from the device with no local copy either: nothing left to play
    const cachedIds = new Set(cacheDirs.filter(e => e.state === 'complete').map(e => e.episodeId));
    const lost = missingEpisodes.filter(e => !cachedIds.has(String(e.id)));

    const sum = list => list.reduce((n, e) => n + (e.bytes || 0), 0);
    return {
      cacheDir: this.hlsManager.cacheDir,
      maxAgeDays: this.hlsCacheMaxAgeMs / 86400000,
      totals: {
        directories: cacheDirs.length,
        bytes: sum(cacheDirs),
        preserved: { count: preserved.length, bytes: sum(preserved) },
        disposable: { count: disposable.length, bytes: sum(disposable) },
        orphans: { count: orphans.length, bytes: sum(orphans) },
        lost: lost.length
      },
      preserved,
      disposable,
      orphans,
      lost
    };
  }

  async maintainHlsCache() {
    // Age out re-creatable caches and report anything that needs a human decision
    try {
      const onDeviceIds = await this.database.getEpisodeIdsOnDevice();
      const removed = await this.hlsManager.cleanupDisposable(
        episodeId => onDeviceIds.has(parseInt(episodeId, 10)),
        this.hlsCacheMaxAgeMs
      );
      if (removed.length > 0) {
        this.log(`Removed ${removed.length} unplayed cache(s) for recordings still on the device`);
      }

      const report = await this.buildCacheReport();
      const gb = bytes => (bytes / 1073741824).toFixed(1);
      this.log(`HLS cache: ${report.totals.directories} dirs, ${gb(report.totals.bytes)} GB ` +
        `(${report.totals.preserved.count} only-copy ${gb(report.totals.preserved.bytes)} GB, ` +
        `${report.totals.disposable.count} re-creatable, ` +
        `${report.totals.orphans.count} orphan ${gb(report.totals.orphans.bytes)} GB, ` +
        `${report.totals.lost} recordings lost with no copy)`);
      if (report.totals.orphans.count > 0) {
        this.log(`  Orphaned cache dirs (no database record): ${report.orphans.map(o => o.episodeId).join(', ')} - see GET /api/cache`);
      }
    } catch (error) {
      this.log(`HLS cache maintenance failed: ${error.message}`);
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

      // Recalculate series statistics (fixes existing databases and ensures counts are correct)
      this.log('Recalculating series statistics...');
      await this.database.recalculateSeriesStats();

      // Initialize HLS stream manager
      this.log('Initializing HLS stream manager...');
      await this.hlsManager.initialize();

      // Initialize Live TV tuner manager
      if (this.liveTVEnabled) {
        this.log('Initializing Live TV tuner manager...');
        this.tunerManager = new TunerManager(this.liveTVConfig);
        await this.tunerManager.initialize();
      }

      // Initialize Guide manager (loads guide data and starts periodic refresh)
      this.log('Initializing Guide manager...');
      await GuideManager.initialize();

      // Setup scheduled discovery
      this.setupScheduler();

      // Start server
      this.app.listen(this.port, this.host, () => {
        this.log(`HDHomeRun DVR API server running on http://${this.host}:${this.port}`);
        this.log(`Pre-cache mode: ${this.preCache ? 'ENABLED' : 'DISABLED'}`);
        this.log(`HLS cache aging: ${this.hlsCacheMaxAgeMs > 0 ? `${this.hlsCacheMaxAgeMs / 86400000} days unplayed (on-device recordings only)` : 'DISABLED'}`);
        if (this.preCache) {
          this.log('  All episodes will be converted to HLS after discovery');
        } else {
          this.log('  Episodes will be converted to HLS on-demand');
        }
        this.log('Available endpoints:');
        this.log('  GET /health - Health check');
        this.log('  GET /api/info - API statistics');
        this.log('  GET /api/shows - All shows/series');
        this.log('  GET /api/shows/:id - Specific show');
        this.log('  GET /api/shows/:id/episodes - Episodes for a show');
        this.log('  GET /api/episodes/recent - Recent episodes');
        this.log('  GET /api/episodes/:id - Get specific episode');
        this.log('  PUT /api/episodes/:id/progress - Update watch progress');
        this.log('  DELETE /api/episodes/:id - Delete episode');
        this.log('  GET /api/cache - HLS cache report (only-copy, re-creatable, orphaned)');
        this.log('  DELETE /api/cache/:episodeId - Remove a re-creatable or orphaned cache');
        this.log('  POST /api/discover - Manual discovery trigger');
        this.log('  GET /api/guide - Program guide (24hr, cached)');
        this.log('  GET /api/guide/search - Search programs');
        this.log('  GET /api/guide/now - What\'s on now');
        this.log('  GET /api/recording-rules - List recording rules');
        this.log('  POST /api/recording-rules - Create recording rule');
        this.log('  DELETE /api/recording-rules/:id - Delete recording rule');
        if (this.liveTVEnabled) {
          this.log('  GET /api/live/channels - Get channel lineup');
          this.log('  POST /api/live/watch - Start watching channel');
          this.log('  POST /api/live/heartbeat - Client heartbeat');
          this.log('  POST /api/live/stop - Stop watching');
          this.log('  GET /api/live/:tunerId/playlist.m3u8 - Live TV HLS playlist');
          this.log('  GET /api/live/tuners - Tuner status (admin)');
        }
        this.log('  GET /api/stream/:episodeId/playlist.m3u8 - HLS stream');
        this.log('  GET /api/stream/:episodeId/status - Transcode status');
      });

      // Run initial discovery in background (doesn't block server startup)
      this.log('Starting initial discovery in background...');
      this.runDiscovery().catch(error => {
        this.log(`Initial discovery failed: ${error.message}`);
      });

    } catch (error) {
      this.log(`Failed to start server: ${error.message}`);
      process.exit(1);
    }
  }

  async stop() {
    this.log('Shutting down server...');

    // Stop guide periodic refresh
    GuideManager.stopPeriodicRefresh();

    // Stop live TV if enabled
    if (this.liveTVEnabled && this.tunerManager) {
      await this.tunerManager.shutdown();
    }

    await this.hlsManager.shutdown();
    await this.database.close();
  }
}

// Handle startup
if (require.main === module) {
  const verbose = process.argv.includes('--verbose') || process.argv.includes('-v');
  const preCache = process.argv.includes('--pre-cache');
  const host = process.env.HOST || '127.0.0.1';
  const port = process.env.PORT || 3000;

  const server = new HDHomeRunServer({ host, port, verbose, preCache });

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
