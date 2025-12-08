/**
 * Live TV Tuner Manager
 * Manages HDHomeRun tuners for live TV streaming
 *
 * Features:
 * - Dynamic tuner pool from multiple devices
 * - Intelligent tuner allocation
 * - Client tracking and heartbeat monitoring
 * - Automatic cleanup on idle/disconnect
 * - Device offline handling
 */

const db = require('asynqlite');
const axios = require('axios');
const LiveStreamManager = require('./live-stream');

class TunerManager {
  constructor(config = {}) {
    this.config = {
      cacheDir: config.cacheDir || 'live-cache',
      bufferMinutes: config.bufferMinutes || 60,
      segmentDuration: config.segmentDuration || 6,
      clientHeartbeat: config.clientHeartbeat || 30,
      missedHeartbeats: config.missedHeartbeats || 2,
      tunerCooldown: config.tunerCooldown || 300,
      pruneInterval: config.pruneInterval || 30,
      maxViewersPerTuner: config.maxViewersPerTuner || 10,
      ...config
    };

    this.tuners = new Map(); // tunerId → TunerInfo
    this.liveStreamManager = new LiveStreamManager(this.config);
    this.backgroundTasks = [];
  }

  /**
   * Initialize tuner manager
   */
  async initialize() {
    console.log('[LiveTV] Initializing tuner manager...');

    // Load existing tuners from database
    await this.loadTunersFromDatabase();

    // Start background tasks
    this.startBackgroundTasks();

    console.log(`[LiveTV] Initialized with ${this.tuners.size} tuners`);
  }

  /**
   * Load tuners from database
   */
  async loadTunersFromDatabase() {
    const tuners = await db.run(`
      SELECT id, device_id, tuner_index, channel_number, state, viewer_count, hls_path
      FROM live_tuners
    `);

    for (const tuner of tuners) {
      this.tuners.set(tuner.id, {
        id: tuner.id,
        deviceId: tuner.device_id,
        deviceIp: null, // Will be updated from device discovery
        tunerIndex: tuner.tuner_index,
        state: tuner.state === 'active' ? 'idle' : tuner.state, // Reset active to idle on startup
        channelNumber: tuner.channel_number,
        viewerCount: 0, // Reset viewer count on startup
        lastAccessed: null,
        streamPid: null,
        hlsPath: tuner.hls_path
      });
    }

    // Reset all tuners to idle on startup
    await db.run(`UPDATE live_tuners SET state = 'idle', viewer_count = 0, stream_pid = NULL`);
  }

  /**
   * Register tuner from device discovery
   * Called when devices are discovered
   */
  async registerTuner(deviceId, deviceIp, tunerIndex) {
    const tunerId = `${deviceId}-tuner-${tunerIndex}`;

    const tunerInfo = {
      id: tunerId,
      deviceId,
      deviceIp,
      tunerIndex,
      state: 'idle',
      channelNumber: null,
      viewerCount: 0,
      lastAccessed: null,
      streamPid: null,
      hlsPath: `${this.config.cacheDir}/${tunerId}`
    };

    this.tuners.set(tunerId, tunerInfo);

    // Upsert to database
    await db.run(`
      INSERT INTO live_tuners (id, device_id, tuner_index, state, hls_path, created_at, updated_at)
      VALUES (?, ?, ?, 'idle', ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
      ON CONFLICT(id) DO UPDATE SET
        device_id = excluded.device_id,
        tuner_index = excluded.tuner_index,
        updated_at = CURRENT_TIMESTAMP
    `, [tunerId, deviceId, tunerIndex, tunerInfo.hlsPath]);

    console.log(`[LiveTV] Registered tuner: ${tunerId}`);
  }

  /**
   * Deregister all tuners for a device
   * Called when device goes offline
   */
  async deregisterDevice(deviceId) {
    console.log(`[LiveTV] Deregistering device: ${deviceId}`);

    const tunersToRemove = [];
    for (const [tunerId, tuner] of this.tuners.entries()) {
      if (tuner.deviceId === deviceId) {
        tunersToRemove.push(tunerId);

        // Stop stream if active
        if (tuner.state === 'active') {
          await this.stopStream(tunerId);
          // TODO: Notify connected clients that stream is unavailable
        }
      }
    }

    // Remove from memory
    for (const tunerId of tunersToRemove) {
      this.tuners.delete(tunerId);
    }

    // Mark as offline in database (don't delete, keep history)
    await db.run(`
      UPDATE live_tuners
      SET state = 'offline', updated_at = CURRENT_TIMESTAMP
      WHERE device_id = ?
    `, [deviceId]);

    console.log(`[LiveTV] Deregistered ${tunersToRemove.length} tuners for ${deviceId}`);
  }

  /**
   * Check HDHomeRun device tuner availability
   * @param {string} deviceIp - Device IP address
   * @returns {Promise<object>} Tuner availability info
   */
  async checkDeviceTuners(deviceIp) {
    try {
      const response = await axios.get(`http://${deviceIp}/status.json`, {
        timeout: 5000
      });

      if (!Array.isArray(response.data)) {
        return { available: false, total: 0, inUse: 0, error: 'Invalid response format' };
      }

      const tuners = response.data;
      const total = tuners.length;

      // A tuner is in use if it has a VctNumber field (or InUse: 1 on some devices)
      // Idle tuners typically only have the Resource field
      const isTunerInUse = (t) => t.InUse === 1 || t.VctNumber !== undefined;

      const inUse = tuners.filter(isTunerInUse).length;
      const available = tuners.filter(t => !isTunerInUse(t));

      return {
        available: available.length > 0,
        total,
        inUse,
        free: available.length,
        tuners: tuners.map(t => ({
          resource: t.Resource,
          inUse: isTunerInUse(t),
          channel: t.VctNumber || null,
          targetIp: t.TargetIP || null
        }))
      };
    } catch (error) {
      console.error(`[LiveTV] Failed to check tuner status on ${deviceIp}:`, error.message);
      return { available: false, total: 0, inUse: 0, error: error.message };
    }
  }

  /**
   * Allocate tuner for a channel
   * Returns tunerId or null if no tuners available
   */
  async allocateTuner(channelNumber, clientId) {
    console.log(`[LiveTV] Allocating tuner for channel ${channelNumber}, client ${clientId}`);

    // 1. Check if channel already streaming on any tuner (reuse)
    for (const [tunerId, tuner] of this.tuners.entries()) {
      if (tuner.state === 'active' &&
          tuner.channelNumber === channelNumber &&
          tuner.viewerCount < this.config.maxViewersPerTuner) {
        console.log(`[LiveTV] Reusing active tuner ${tunerId} for channel ${channelNumber}`);
        await this.registerViewer(tunerId, clientId, channelNumber);
        return tunerId;
      }
    }

    // 2. Find idle tuner and verify device has capacity
    for (const [tunerId, tuner] of this.tuners.entries()) {
      if (tuner.state === 'idle' && tuner.deviceIp) {
        // Check if device actually has available tuners before starting
        console.log(`[LiveTV] Checking tuner availability on device ${tuner.deviceIp}`);
        const deviceStatus = await this.checkDeviceTuners(tuner.deviceIp);

        if (!deviceStatus.available) {
          console.log(`[LiveTV] Device ${tuner.deviceIp} has no available tuners (${deviceStatus.inUse}/${deviceStatus.total} in use)`);
          if (deviceStatus.tuners && deviceStatus.tuners.length > 0) {
            // Log what's using the tuners
            deviceStatus.tuners.forEach(t => {
              if (t.inUse) {
                console.log(`[LiveTV]   ${t.resource}: in use by ${t.targetIp || 'unknown'}, channel ${t.channel || 'unknown'}`);
              }
            });
          }
          continue; // Try next device
        }

        console.log(`[LiveTV] Device ${tuner.deviceIp} has ${deviceStatus.free} available tuner(s)`);
        console.log(`[LiveTV] Allocating idle tuner ${tunerId}`);
        await this.startStream(tunerId, channelNumber);
        await this.registerViewer(tunerId, clientId, channelNumber);
        return tunerId;
      }
    }

    // 3. Find cooldown tuner with no viewers and verify device has capacity
    for (const [tunerId, tuner] of this.tuners.entries()) {
      if (tuner.state === 'cooldown' && tuner.viewerCount === 0 && tuner.deviceIp) {
        // Check if device actually has available tuners before starting
        console.log(`[LiveTV] Checking tuner availability on device ${tuner.deviceIp} for cooldown tuner`);
        const deviceStatus = await this.checkDeviceTuners(tuner.deviceIp);

        if (!deviceStatus.available) {
          console.log(`[LiveTV] Device ${tuner.deviceIp} has no available tuners (${deviceStatus.inUse}/${deviceStatus.total} in use)`);
          continue; // Try next device
        }

        console.log(`[LiveTV] Reallocating cooldown tuner ${tunerId}`);
        await this.startStream(tunerId, channelNumber);
        await this.registerViewer(tunerId, clientId, channelNumber);
        return tunerId;
      }
    }

    console.log(`[LiveTV] No tuners available`);
    return null;
  }

  /**
   * Start streaming on a tuner
   */
  async startStream(tunerId, channelNumber) {
    const tuner = this.tuners.get(tunerId);
    if (!tuner) {
      throw new Error(`Tuner not found: ${tunerId}`);
    }

    console.log(`[LiveTV] Starting stream on ${tunerId} for channel ${channelNumber}`);

    // Build HDHomeRun stream URL using /auto/ to let device pick best available tuner
    // This handles cases where specific tuners may not support certain channels (e.g., HEVC)
    const sourceUrl = `http://${tuner.deviceIp}:5004/auto/v${channelNumber}`;

    // Pre-check: Verify stream URL is accessible before starting FFmpeg
    try {
      console.log(`[LiveTV] Pre-checking stream URL: ${sourceUrl}`);
      const checkResponse = await axios.get(sourceUrl, {
        timeout: 3000,
        maxContentLength: 1024, // Only read first 1KB to test connectivity
        validateStatus: () => true, // Don't throw on non-2xx status
        responseType: 'stream'
      });

      // Immediately close the stream
      if (checkResponse.data && checkResponse.data.destroy) {
        checkResponse.data.destroy();
      }

      if (checkResponse.status === 503) {
        const errorCode = checkResponse.headers['x-hdhomerun-error'];
        let errorMsg = 'HDHomeRun device returned 503 Service Unavailable';

        if (errorCode === '805') {
          errorMsg = 'All tuners are in use (error 805). No tuners available on device.';
        } else if (errorCode === '804') {
          errorMsg = 'Requested tuner is in use (error 804)';
        } else if (errorCode === '811') {
          errorMsg = 'Content protection required (error 811). Channel may be DRM-protected.';
        } else if (errorCode) {
          errorMsg = `HDHomeRun error ${errorCode}`;
        }

        throw new Error(errorMsg);
      }

      if (checkResponse.status >= 400) {
        throw new Error(`Stream URL returned HTTP ${checkResponse.status}`);
      }

      console.log(`[LiveTV] Stream URL check passed`);
    } catch (error) {
      if (error.code === 'ECONNABORTED') {
        throw new Error(`Connection timeout to HDHomeRun device at ${tuner.deviceIp}`);
      }
      throw error;
    }

    try {
      // Start FFmpeg transcoding
      const pid = await this.liveStreamManager.startLiveStream(
        tunerId,
        sourceUrl,
        channelNumber
      );

      // Update tuner state
      tuner.state = 'active';
      tuner.channelNumber = channelNumber;
      tuner.streamPid = pid;
      tuner.lastAccessed = Date.now();

      // Update database
      await db.run(`
        UPDATE live_tuners
        SET state = 'active',
            channel_number = ?,
            stream_pid = ?,
            started_at = CURRENT_TIMESTAMP,
            last_accessed = CURRENT_TIMESTAMP,
            updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `, [channelNumber, pid, tunerId]);

      console.log(`[LiveTV] Stream started on ${tunerId} (PID: ${pid})`);
    } catch (error) {
      console.error(`[LiveTV] Failed to start stream on ${tunerId}:`, error);
      throw error;
    }
  }

  /**
   * Stop streaming on a tuner
   */
  async stopStream(tunerId) {
    const tuner = this.tuners.get(tunerId);
    if (!tuner) {
      return;
    }

    console.log(`[LiveTV] Stopping stream on ${tunerId}`);

    // Stop FFmpeg process
    if (tuner.streamPid) {
      await this.liveStreamManager.stopLiveStream(tunerId);
    }

    // Clean up HLS cache
    await this.liveStreamManager.cleanupCache(tuner.hlsPath);

    // Update tuner state
    tuner.state = 'idle';
    tuner.channelNumber = null;
    tuner.streamPid = null;

    // Update database
    await db.run(`
      UPDATE live_tuners
      SET state = 'idle',
          channel_number = NULL,
          stream_pid = NULL,
          updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `, [tunerId]);

    console.log(`[LiveTV] Stream stopped on ${tunerId}`);
  }

  /**
   * Register a viewer for a tuner
   */
  async registerViewer(tunerId, clientId, channelNumber) {
    const tuner = this.tuners.get(tunerId);
    if (!tuner) {
      throw new Error(`Tuner not found: ${tunerId}`);
    }

    console.log(`[LiveTV] Registering viewer ${clientId} on ${tunerId}`);

    // Add to database
    await db.run(`
      INSERT INTO live_viewers (tuner_id, client_id, channel_number, last_heartbeat, created_at)
      VALUES (?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
      ON CONFLICT(client_id) DO UPDATE SET
        tuner_id = excluded.tuner_id,
        channel_number = excluded.channel_number,
        last_heartbeat = CURRENT_TIMESTAMP
    `, [tunerId, clientId, channelNumber]);

    // Update viewer count
    tuner.viewerCount++;
    tuner.lastAccessed = Date.now();

    await db.run(`
      UPDATE live_tuners
      SET viewer_count = ?,
          last_accessed = CURRENT_TIMESTAMP
      WHERE id = ?
    `, [tuner.viewerCount, tunerId]);
  }

  /**
   * Update viewer heartbeat
   */
  async heartbeat(clientId) {
    const result = await db.run(`
      UPDATE live_viewers
      SET last_heartbeat = CURRENT_TIMESTAMP
      WHERE client_id = ?
      RETURNING tuner_id
    `, [clientId]);

    if (result && result.length > 0) {
      const tunerId = result[0].tuner_id;
      const tuner = this.tuners.get(tunerId);
      if (tuner) {
        tuner.lastAccessed = Date.now();
      }
      return true;
    }

    return false;
  }

  /**
   * Release a viewer
   */
  async releaseViewer(clientId) {
    console.log(`[LiveTV] Releasing viewer ${clientId}`);

    const result = await db.run(`
      DELETE FROM live_viewers
      WHERE client_id = ?
      RETURNING tuner_id
    `, [clientId]);

    if (result && result.length > 0) {
      const tunerId = result[0].tuner_id;
      const tuner = this.tuners.get(tunerId);

      if (tuner) {
        tuner.viewerCount = Math.max(0, tuner.viewerCount - 1);

        await db.run(`
          UPDATE live_tuners
          SET viewer_count = ?
          WHERE id = ?
        `, [tuner.viewerCount, tunerId]);

        // If no more viewers, move to cooldown
        if (tuner.viewerCount === 0) {
          console.log(`[LiveTV] No more viewers on ${tunerId}, entering cooldown`);
          tuner.state = 'cooldown';
          await db.run(`
            UPDATE live_tuners
            SET state = 'cooldown'
            WHERE id = ?
          `, [tunerId]);
        }
      }
    }
  }

  /**
   * Get tuner status
   */
  async getTunerStatus() {
    const tuners = Array.from(this.tuners.values()).map(tuner => ({
      id: tuner.id,
      deviceId: tuner.deviceId,
      deviceIp: tuner.deviceIp,
      tunerIndex: tuner.tunerIndex,
      state: tuner.state,
      channelNumber: tuner.channelNumber,
      viewerCount: tuner.viewerCount,
      streamPid: tuner.streamPid,
      hlsPath: tuner.hlsPath
    }));

    return tuners;
  }

  /**
   * Background task: Check for dead clients
   */
  async checkDeadClients() {
    const timeout = this.config.clientHeartbeat * this.config.missedHeartbeats;

    const deadClients = await db.run(`
      SELECT client_id
      FROM live_viewers
      WHERE (julianday('now') - julianday(last_heartbeat)) * 86400 > ?
    `, [timeout]);

    for (const client of deadClients) {
      console.log(`[LiveTV] Removing dead client: ${client.client_id}`);
      await this.releaseViewer(client.client_id);
    }
  }

  /**
   * Background task: Check for idle tuners
   */
  async checkIdleTuners() {
    const now = Date.now();
    const cooldownMs = this.config.tunerCooldown * 1000;

    for (const [tunerId, tuner] of this.tuners.entries()) {
      if (tuner.state === 'cooldown' &&
          tuner.viewerCount === 0 &&
          tuner.lastAccessed &&
          (now - tuner.lastAccessed) > cooldownMs) {
        console.log(`[LiveTV] Stopping idle tuner: ${tunerId}`);
        await this.stopStream(tunerId);
      }
    }
  }

  /**
   * Start background tasks
   */
  startBackgroundTasks() {
    console.log('[LiveTV] Starting background tasks...');

    // Check for dead clients every 30 seconds
    this.backgroundTasks.push(
      setInterval(() => this.checkDeadClients(), 30000)
    );

    // Check for idle tuners every 60 seconds
    this.backgroundTasks.push(
      setInterval(() => this.checkIdleTuners(), 60000)
    );
  }

  /**
   * Stop all background tasks
   */
  stopBackgroundTasks() {
    console.log('[LiveTV] Stopping background tasks...');
    for (const task of this.backgroundTasks) {
      clearInterval(task);
    }
    this.backgroundTasks = [];
  }

  /**
   * Shutdown - stop all streams and tasks
   */
  async shutdown() {
    console.log('[LiveTV] Shutting down...');

    this.stopBackgroundTasks();
    await this.liveStreamManager.stopAllStreams();

    console.log('[LiveTV] Shutdown complete');
  }
}

module.exports = TunerManager;
