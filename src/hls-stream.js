const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const { promisify } = require('util');

const mkdir = promisify(fs.mkdir);
const readdir = promisify(fs.readdir);
const unlink = promisify(fs.unlink);
const stat = promisify(fs.stat);
const readFile = promisify(fs.readFile);
const writeFile = promisify(fs.writeFile);

// Transcoding states
const TRANSCODE_STATE = {
  PENDING: 'pending',
  TRANSCODING: 'transcoding',
  COMPLETE: 'complete',
  ERROR: 'error'
};

class HLSStreamManager {
  constructor(options = {}) {
    this.verbose = options.verbose || false;
    this.segmentDuration = options.segmentDuration || 4; // 4 second segments
    this.cacheDir = options.cacheDir || path.join(__dirname, '../hls-cache');
    this.cleanupInterval = options.cleanupInterval || 3600000; // 1 hour
    this.maxCacheAge = options.maxCacheAge || 2592000000; // 30 days

    // Transcoding jobs: episodeId -> { state, process, startTime, progress, error }
    this.transcodeJobs = new Map();

    // Load existing cache state on startup
    this.loadCacheState();
  }

  async initialize() {
    // Create cache directory if it doesn't exist
    try {
      await mkdir(this.cacheDir, { recursive: true });
      this.log('HLS cache directory initialized');

      // Scan for existing transcoded content
      await this.scanExistingCache();
    } catch (error) {
      if (error.code !== 'EEXIST') {
        throw error;
      }
    }
  }

  log(message) {
    const timestamp = new Date().toISOString();
    console.log(`[${timestamp}] [HLS] ${message}`);
  }

  debug(message) {
    if (this.verbose) {
      const timestamp = new Date().toISOString();
      console.log(`[${timestamp}] [HLS] [DEBUG] ${message}`);
    }
  }

  /**
   * Scan cache directory for existing transcoded episodes
   */
  async scanExistingCache() {
    try {
      const entries = await readdir(this.cacheDir);

      for (const entry of entries) {
        const episodeDir = path.join(this.cacheDir, entry);
        const stats = await stat(episodeDir);

        if (stats.isDirectory()) {
          const playlistPath = path.join(episodeDir, 'stream.m3u8');
          const statePath = path.join(episodeDir, 'transcode.json');

          // Check if transcode is complete
          try {
            await stat(playlistPath);
            const stateData = await this.loadTranscodeState(entry);

            if (stateData && stateData.state === TRANSCODE_STATE.COMPLETE) {
              this.transcodeJobs.set(entry, {
                state: TRANSCODE_STATE.COMPLETE,
                startTime: stateData.startTime,
                endTime: stateData.endTime,
                progress: 100,
                outputDir: episodeDir
              });
              this.debug(`Found cached episode ${entry}`);
            }
          } catch (error) {
            // Incomplete transcode, will be restarted if requested
            this.debug(`Incomplete transcode found for episode ${entry}`);
          }
        }
      }

      this.log(`Loaded ${this.transcodeJobs.size} cached episodes`);
    } catch (error) {
      this.debug(`Error scanning cache: ${error.message}`);
    }
  }

  /**
   * Load transcode state from disk
   */
  async loadTranscodeState(episodeId) {
    const statePath = path.join(this.getStreamDir(episodeId), 'transcode.json');

    try {
      const data = await readFile(statePath, 'utf8');
      return JSON.parse(data);
    } catch (error) {
      return null;
    }
  }

  /**
   * Save transcode state to disk
   */
  async saveTranscodeState(episodeId, state) {
    const statePath = path.join(this.getStreamDir(episodeId), 'transcode.json');

    try {
      await writeFile(statePath, JSON.stringify(state, null, 2));
    } catch (error) {
      this.debug(`Error saving transcode state: ${error.message}`);
    }
  }

  /**
   * Load cache state from memory
   */
  loadCacheState() {
    // This would load from a persistent store if needed
    // For now, we just scan the filesystem on startup
  }

  /**
   * Start transcoding an episode to HLS
   * @param {string} episodeId - Episode ID
   * @param {string} sourceUrl - HDHomeRun stream URL
   * @returns {Promise<string>} - Path to output directory
   */
  async startTranscode(episodeId, sourceUrl) {
    // Check if already transcoded
    const existingJob = this.transcodeJobs.get(episodeId);

    if (existingJob) {
      if (existingJob.state === TRANSCODE_STATE.COMPLETE) {
        this.debug(`Episode ${episodeId} already transcoded`);
        return existingJob.outputDir;
      }

      if (existingJob.state === TRANSCODE_STATE.TRANSCODING) {
        this.debug(`Episode ${episodeId} is already being transcoded`);
        return existingJob.outputDir;
      }
    }

    const outputDir = this.getStreamDir(episodeId);

    // Create output directory
    await mkdir(outputDir, { recursive: true });

    // Build FFmpeg command for full-file transcoding
    const outputPath = path.join(outputDir, 'stream.m3u8');
    const segmentPattern = path.join(outputDir, 'segment%04d.ts');

    const ffmpegArgs = [
      '-i', sourceUrl,
      '-c:v', 'libx264',          // Transcode to H.264
      '-preset', 'veryfast',       // Fast encoding
      '-crf', '23',                // Quality (lower = better, 23 is default)
      '-maxrate', '5000k',         // Max bitrate for AppleTV
      '-bufsize', '10000k',        // Buffer size
      '-g', '48',                  // GOP size (keyframe interval)
      '-sc_threshold', '0',        // Disable scene change detection
      '-c:a', 'aac',               // Transcode audio to AAC
      '-b:a', '192k',              // Audio bitrate
      '-ac', '2',                  // Stereo audio (downmix from 5.1)
      '-ar', '48000',              // Audio sample rate
      '-f', 'hls',                 // HLS format
      '-hls_time', String(this.segmentDuration),
      '-hls_list_size', '0',       // Keep ALL segments in playlist
      '-hls_flags', 'append_list', // No deleting segments, just append
      '-hls_segment_filename', segmentPattern,
      outputPath
    ];

    this.log(`Starting transcode for episode ${episodeId}`);
    this.debug(`Source: ${sourceUrl}`);
    this.debug(`Output: ${outputPath}`);
    this.debug(`FFmpeg args: ${ffmpegArgs.join(' ')}`);

    // Spawn FFmpeg process
    const ffmpeg = spawn('ffmpeg', ffmpegArgs);

    // Track the transcode job
    const job = {
      state: TRANSCODE_STATE.TRANSCODING,
      process: ffmpeg,
      startTime: Date.now(),
      progress: 0,
      outputDir,
      sourceUrl
    };

    this.transcodeJobs.set(episodeId, job);

    // Save initial state
    await this.saveTranscodeState(episodeId, {
      state: TRANSCODE_STATE.TRANSCODING,
      startTime: job.startTime,
      sourceUrl
    });

    // Handle FFmpeg output for progress tracking
    let stderr = '';

    ffmpeg.stderr.on('data', (data) => {
      const output = data.toString();
      stderr += output;

      // Try to extract progress information
      const timeMatch = output.match(/time=(\d+:\d+:\d+\.\d+)/);
      if (timeMatch) {
        this.debug(`Transcode progress for ${episodeId}: ${timeMatch[1]}`);
      }

      this.debug(`FFmpeg: ${output.trim()}`);
    });

    ffmpeg.on('error', (error) => {
      this.log(`FFmpeg error for episode ${episodeId}: ${error.message}`);
      job.state = TRANSCODE_STATE.ERROR;
      job.error = error.message;

      this.saveTranscodeState(episodeId, {
        state: TRANSCODE_STATE.ERROR,
        startTime: job.startTime,
        endTime: Date.now(),
        error: error.message
      });
    });

    ffmpeg.on('close', (code) => {
      if (code === 0) {
        this.log(`Transcode completed successfully for episode ${episodeId}`);
        job.state = TRANSCODE_STATE.COMPLETE;
        job.endTime = Date.now();
        job.progress = 100;
        delete job.process;

        this.saveTranscodeState(episodeId, {
          state: TRANSCODE_STATE.COMPLETE,
          startTime: job.startTime,
          endTime: job.endTime,
          sourceUrl: job.sourceUrl
        });
      } else {
        this.log(`FFmpeg process for episode ${episodeId} exited with code ${code}`);
        job.state = TRANSCODE_STATE.ERROR;
        job.error = `FFmpeg exited with code ${code}`;

        this.saveTranscodeState(episodeId, {
          state: TRANSCODE_STATE.ERROR,
          startTime: job.startTime,
          endTime: Date.now(),
          error: job.error,
          stderr: stderr.slice(-1000) // Last 1000 chars of stderr
        });
      }
    });

    // Wait a moment for FFmpeg to start generating files
    await this.waitForPlaylist(outputPath, 15000); // Wait up to 15 seconds

    return outputDir;
  }

  /**
   * Wait for playlist file to be created
   */
  async waitForPlaylist(playlistPath, timeout = 15000) {
    const startTime = Date.now();

    while (Date.now() - startTime < timeout) {
      try {
        await stat(playlistPath);
        this.debug(`Playlist ready: ${playlistPath}`);
        return true;
      } catch (error) {
        // File doesn't exist yet, wait a bit
        await new Promise(resolve => setTimeout(resolve, 500));
      }
    }

    throw new Error('Timeout waiting for HLS playlist to be generated');
  }

  /**
   * Get the stream directory for an episode
   */
  getStreamDir(episodeId) {
    return path.join(this.cacheDir, String(episodeId));
  }

  /**
   * Get the playlist file path for an episode
   */
  getPlaylistPath(episodeId) {
    return path.join(this.getStreamDir(episodeId), 'stream.m3u8');
  }

  /**
   * Check if episode is transcoded or being transcoded
   */
  getTranscodeStatus(episodeId) {
    const job = this.transcodeJobs.get(episodeId);

    if (!job) {
      return { state: TRANSCODE_STATE.PENDING };
    }

    return {
      state: job.state,
      progress: job.progress,
      startTime: job.startTime,
      endTime: job.endTime,
      error: job.error
    };
  }

  /**
   * Check if a segment file exists
   */
  async segmentExists(episodeId, filename) {
    const segmentPath = path.join(this.getStreamDir(episodeId), filename);

    try {
      await stat(segmentPath);
      return true;
    } catch (error) {
      return false;
    }
  }

  /**
   * Delete transcode cache for an episode
   */
  async deleteTranscode(episodeId) {
    const job = this.transcodeJobs.get(episodeId);

    // Kill process if still running
    if (job && job.process && !job.process.killed) {
      this.log(`Killing transcode process for episode ${episodeId}`);
      job.process.kill('SIGTERM');
    }

    // Remove from jobs map
    this.transcodeJobs.delete(episodeId);

    // Clean up files
    const outputDir = this.getStreamDir(episodeId);
    await this.cleanupStreamDir(outputDir);
  }

  /**
   * Clean up old transcodes
   */
  async cleanup() {
    const now = Date.now();

    // Check for very old cached transcodes (30 days default)
    try {
      const entries = await readdir(this.cacheDir);

      for (const entry of entries) {
        const entryPath = path.join(this.cacheDir, entry);
        const stats = await stat(entryPath);

        if (stats.isDirectory()) {
          const age = now - stats.mtimeMs;

          if (age > this.maxCacheAge) {
            this.log(`Cleaning up old cache: ${entry} (age: ${Math.round(age / 86400000)} days)`);
            await this.deleteTranscode(entry);
          }
        }
      }
    } catch (error) {
      this.debug(`Cleanup error: ${error.message}`);
    }
  }

  /**
   * Clean up a stream directory
   */
  async cleanupStreamDir(dirPath) {
    try {
      const files = await readdir(dirPath);

      for (const file of files) {
        const filePath = path.join(dirPath, file);
        await unlink(filePath);
      }

      await fs.promises.rmdir(dirPath);
      this.debug(`Cleaned up directory: ${dirPath}`);
    } catch (error) {
      this.debug(`Error cleaning up ${dirPath}: ${error.message}`);
    }
  }

  /**
   * Shutdown - stop all transcoding and cleanup
   */
  async shutdown() {
    this.log('Shutting down HLS stream manager...');

    // Stop all active transcodes
    for (const [episodeId, job] of this.transcodeJobs.entries()) {
      if (job.state === TRANSCODE_STATE.TRANSCODING && job.process) {
        this.log(`Stopping transcode for episode ${episodeId}`);
        job.process.kill('SIGTERM');
      }
    }

    this.log('HLS stream manager shut down complete');
  }
}

module.exports = HLSStreamManager;
