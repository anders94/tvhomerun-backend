/**
 * Live Stream Manager
 * Manages FFmpeg processes for live TV HLS transcoding
 *
 * Features:
 * - Start/stop FFmpeg processes for live streams
 * - Track active streams by tuner ID
 * - Automatic HLS segment management
 * - Process monitoring and error handling
 */

const { spawn } = require('child_process');
const fs = require('fs').promises;
const path = require('path');

class LiveStreamManager {
  constructor(config = {}) {
    this.config = {
      cacheDir: config.cacheDir || 'live-cache',
      segmentDuration: config.segmentDuration || 6,
      bufferMinutes: config.bufferMinutes || 60,
      ...config
    };

    this.activeStreams = new Map(); // tunerId → stream info
  }

  /**
   * Start live stream transcoding
   * @param {string} tunerId - Tuner identifier (e.g., "10AA5474-tuner-0")
   * @param {string} sourceUrl - HDHomeRun stream URL
   * @param {string} channelNumber - Channel being streamed
   * @returns {Promise<number>} FFmpeg process ID
   */
  async startLiveStream(tunerId, sourceUrl, channelNumber) {
    // Check if stream already active
    if (this.activeStreams.has(tunerId)) {
      console.log(`[LiveStream] Stream already active for ${tunerId}`);
      return this.activeStreams.get(tunerId).pid;
    }

    // Create cache directory
    const hlsPath = path.join(this.config.cacheDir, tunerId);
    await fs.mkdir(hlsPath, { recursive: true });

    const playlistPath = path.join(hlsPath, 'playlist.m3u8');
    const segmentPath = path.join(hlsPath, 'segment-%d.ts');

    // Calculate HLS list size (number of segments to keep)
    const segmentsToKeep = Math.ceil((this.config.bufferMinutes * 60) / this.config.segmentDuration);

    // FFmpeg command for live TV transcoding
    // Settings aligned with recorded show transcoding (hls-stream.js)
    const ffmpegArgs = [
      // Input options (before -i)
      '-fflags', '+discardcorrupt+genpts',  // Discard corrupt frames, generate PTS
      '-err_detect', 'ignore_err',          // Ignore decoding errors during startup
      '-analyzeduration', '3000000',        // Analyze for 3 seconds to detect streams
      '-probesize', '10000000',             // Probe 10MB to find stream info
      '-avoid_negative_ts', 'make_zero',    // Shift timestamps to start at zero
      '-i', sourceUrl,
      // Video: transcode to H.264 for iOS/web compatibility
      // Many broadcast channels use MPEG-2 which iOS doesn't support in HLS
      '-c:v', 'libx264',
      '-preset', 'veryfast',                // Fast encoding
      '-crf', '23',                         // Quality (lower = better, 23 is default)
      '-maxrate', '5000k',                  // Max bitrate for AppleTV
      '-bufsize', '10000k',                 // Buffer size
      '-g', '48',                           // GOP size (keyframe interval)
      '-sc_threshold', '0',                 // Disable scene change detection
      // Audio: transcode to AAC
      '-c:a', 'aac',
      '-b:a', '128k',                       // Audio bitrate
      '-ac', '2',                           // Stereo audio (downmix from 5.1)
      '-ar', '48000',                       // Audio sample rate
      // HLS output format
      '-f', 'hls',
      '-hls_time', this.config.segmentDuration.toString(),
      '-hls_list_size', '0',  // Keep ALL segments (like recorded shows)
      '-hls_flags', 'append_list+omit_endlist+independent_segments', // Clean HLS for iOS
      '-hls_segment_filename', segmentPath,
      '-hls_segment_type', 'mpegts',        // Use MPEG-TS segments (better compatibility)
      '-start_number', '0',                 // Start segment numbering at 0
      '-muxdelay', '0',                     // No muxing delay
      '-muxpreload', '0',                   // No mux preload
      playlistPath
    ];

    console.log(`[LiveStream] Starting stream for ${tunerId} on channel ${channelNumber}`);
    console.log(`[LiveStream] Source: ${sourceUrl}`);
    console.log(`[LiveStream] Output: ${hlsPath}`);

    // Spawn FFmpeg process
    const ffmpeg = spawn('ffmpeg', ffmpegArgs, {
      stdio: ['ignore', 'pipe', 'pipe']
    });

    const streamInfo = {
      tunerId,
      channelNumber,
      sourceUrl,
      hlsPath,
      playlistPath,
      pid: ffmpeg.pid,
      process: ffmpeg,
      startTime: Date.now(),
      errors: []
    };

    // Handle FFmpeg stdout
    ffmpeg.stdout.on('data', (data) => {
      // Log first few lines, then be quiet
      if (streamInfo.errors.length < 5) {
        console.log(`[LiveStream ${tunerId}] ${data.toString().trim()}`);
      }
    });

    // Handle FFmpeg stderr (where FFmpeg logs)
    ffmpeg.stderr.on('data', (data) => {
      const message = data.toString().trim();

      // Only log important messages
      if (message.includes('error') || message.includes('Error')) {
        console.error(`[LiveStream ${tunerId}] ERROR: ${message}`);
        streamInfo.errors.push({ time: Date.now(), message });
      } else if (streamInfo.errors.length < 3) {
        // Log first few status messages
        console.log(`[LiveStream ${tunerId}] ${message}`);
      }
    });

    // Handle process exit
    ffmpeg.on('exit', (code, signal) => {
      console.log(`[LiveStream ${tunerId}] Process exited with code ${code}, signal ${signal}`);
      this.activeStreams.delete(tunerId);
    });

    // Handle errors
    ffmpeg.on('error', (error) => {
      console.error(`[LiveStream ${tunerId}] Process error:`, error);
      streamInfo.errors.push({ time: Date.now(), message: error.message });
      this.activeStreams.delete(tunerId);
    });

    // Store stream info
    this.activeStreams.set(tunerId, streamInfo);

    // Wait for playlist to be created (with timeout)
    await this.waitForPlaylist(playlistPath, 15000);

    console.log(`[LiveStream] Stream ${tunerId} started successfully (PID: ${ffmpeg.pid})`);
    return ffmpeg.pid;
  }

  /**
   * Stop live stream transcoding
   * @param {string} tunerId - Tuner identifier
   * @returns {Promise<boolean>} Success status
   */
  async stopLiveStream(tunerId) {
    const streamInfo = this.activeStreams.get(tunerId);
    if (!streamInfo) {
      console.log(`[LiveStream] No active stream for ${tunerId}`);
      return false;
    }

    console.log(`[LiveStream] Stopping stream ${tunerId} (PID: ${streamInfo.pid})`);

    return new Promise((resolve) => {
      const process = streamInfo.process;

      // Set timeout for force kill
      const killTimeout = setTimeout(() => {
        console.log(`[LiveStream] Force killing ${tunerId}`);
        process.kill('SIGKILL');
        resolve(true);
      }, 5000);

      // Try graceful shutdown first
      process.on('exit', () => {
        clearTimeout(killTimeout);
        this.activeStreams.delete(tunerId);
        console.log(`[LiveStream] Stream ${tunerId} stopped`);
        resolve(true);
      });

      // Send SIGTERM for graceful shutdown
      process.kill('SIGTERM');
    });
  }

  /**
   * Get status of a live stream
   * @param {string} tunerId - Tuner identifier
   * @returns {object|null} Stream status
   */
  getStreamStatus(tunerId) {
    const streamInfo = this.activeStreams.get(tunerId);
    if (!streamInfo) {
      return null;
    }

    return {
      tunerId: streamInfo.tunerId,
      channelNumber: streamInfo.channelNumber,
      sourceUrl: streamInfo.sourceUrl,
      hlsPath: streamInfo.hlsPath,
      pid: streamInfo.pid,
      startTime: streamInfo.startTime,
      uptime: Date.now() - streamInfo.startTime,
      errorCount: streamInfo.errors.length,
      recentErrors: streamInfo.errors.slice(-5)
    };
  }

  /**
   * Check if stream is active
   * @param {string} tunerId - Tuner identifier
   * @returns {boolean}
   */
  isStreamActive(tunerId) {
    return this.activeStreams.has(tunerId);
  }

  /**
   * Get all active streams
   * @returns {Array} Array of stream statuses
   */
  getAllStreams() {
    return Array.from(this.activeStreams.keys()).map(tunerId =>
      this.getStreamStatus(tunerId)
    );
  }

  /**
   * Wait for playlist file to be created
   * @param {string} playlistPath - Path to playlist.m3u8
   * @param {number} timeout - Timeout in milliseconds
   * @returns {Promise<void>}
   */
  async waitForPlaylist(playlistPath, timeout = 15000) {
    const startTime = Date.now();
    const checkInterval = 500;

    while (Date.now() - startTime < timeout) {
      try {
        await fs.access(playlistPath);
        // File exists, check if it has content
        const stats = await fs.stat(playlistPath);
        if (stats.size > 0) {
          return;
        }
      } catch (err) {
        // File doesn't exist yet, wait and retry
      }

      await new Promise(resolve => setTimeout(resolve, checkInterval));
    }

    throw new Error(`Timeout waiting for playlist at ${playlistPath}`);
  }

  /**
   * Wait for first segment file to be created
   * @param {string} tunerId - Tuner identifier
   * @param {number} timeout - Timeout in milliseconds
   * @returns {Promise<void>}
   */
  async waitForFirstSegment(tunerId, timeout = 20000) {
    const streamInfo = this.activeStreams.get(tunerId);
    if (!streamInfo) {
      throw new Error(`No active stream for tuner ${tunerId}`);
    }

    const hlsPath = streamInfo.hlsPath;
    const firstSegmentPath = path.join(hlsPath, 'segment-0.ts');
    const startTime = Date.now();
    const checkInterval = 500;

    console.log(`[LiveStream] Waiting for first segment: ${firstSegmentPath}`);

    while (Date.now() - startTime < timeout) {
      try {
        await fs.access(firstSegmentPath);
        // File exists, check if it has reasonable content
        const stats = await fs.stat(firstSegmentPath);
        if (stats.size > 10000) { // At least 10KB to ensure it's a valid segment
          console.log(`[LiveStream] First segment ready: ${firstSegmentPath} (${stats.size} bytes)`);
          return;
        }
      } catch (err) {
        // File doesn't exist yet, wait and retry
      }

      await new Promise(resolve => setTimeout(resolve, checkInterval));
    }

    throw new Error(`Timeout waiting for first segment at ${firstSegmentPath}`);
  }

  /**
   * Clean up HLS cache directory
   * @param {string} hlsPath - Path to HLS cache directory
   * @returns {Promise<void>}
   */
  async cleanupCache(hlsPath) {
    try {
      await fs.rm(hlsPath, { recursive: true, force: true });
      console.log(`[LiveStream] Cleaned up cache: ${hlsPath}`);
    } catch (err) {
      console.error(`[LiveStream] Failed to clean up ${hlsPath}:`, err.message);
    }
  }

  /**
   * Stop all active streams
   * @returns {Promise<void>}
   */
  async stopAllStreams() {
    console.log(`[LiveStream] Stopping all active streams (${this.activeStreams.size})`);

    const stopPromises = Array.from(this.activeStreams.keys()).map(tunerId =>
      this.stopLiveStream(tunerId)
    );

    await Promise.all(stopPromises);
  }
}

module.exports = LiveStreamManager;
