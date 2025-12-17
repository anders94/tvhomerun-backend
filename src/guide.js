/**
 * Program Guide Module
 * Manages EPG (Electronic Program Guide) data with intelligent caching
 *
 * Caching Strategy:
 * - Cache guide data in database (accumulates historical data over time)
 * - Refresh from cloud API when data is stale (> 15 minutes old)
 * - API returns only recent/upcoming programs (not full historical data)
 * - Guide data spans current time + 24 hours by default
 */

const axios = require('axios');
const db = require('asynqlite');

class GuideManager {
  constructor() {
    this.CACHE_DURATION = 12 * 60 * 60 * 1000; // 12 hours in milliseconds
    this.DEFAULT_DURATION_HOURS = 24; // Default guide window
    this.refreshTimer = null;
  }

  /**
   * Get device auth token from first available device
   */
  async getDeviceAuth() {
    const devices = await db.run('SELECT device_auth FROM devices WHERE device_auth IS NOT NULL LIMIT 1');
    if (!devices || devices.length === 0) {
      throw new Error('No devices found with authentication token');
    }
    return devices[0].device_auth;
  }

  /**
   * Check if cached guide data is fresh
   */
  async isGuideFresh() {
    const results = await db.run(`
      SELECT MAX(last_updated) as last_update
      FROM guide_channels
    `);

    if (!results || results.length === 0 || !results[0].last_update) {
      return false;
    }

    const lastUpdate = new Date(results[0].last_update).getTime();
    const now = Date.now();
    const age = now - lastUpdate;

    return age < this.CACHE_DURATION;
  }

  /**
   * Fetch guide data from HDHomeRun cloud API
   */
  async fetchGuideFromCloud(options = {}) {
    const {
      start = Math.floor(Date.now() / 1000),
      duration = this.DEFAULT_DURATION_HOURS,
      channel = null
    } = options;

    const deviceAuth = await this.getDeviceAuth();
    const params = {
      DeviceAuth: deviceAuth,
      Start: start,
      Duration: duration
    };

    if (channel) {
      params.Channel = channel;
    }

    const response = await axios.get('https://api.hdhomerun.com/api/guide', {
      params,
      timeout: 10000
    });

    return response.data;
  }

  /**
   * Cache channel information in database
   */
  async cacheChannel(channel) {
    await db.run(`
      INSERT INTO guide_channels (guide_number, guide_name, affiliate, image_url, channel_id, last_updated)
      VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(guide_number) DO UPDATE SET
        guide_name = excluded.guide_name,
        affiliate = excluded.affiliate,
        image_url = excluded.image_url,
        channel_id = excluded.channel_id,
        last_updated = CURRENT_TIMESTAMP
    `, [
      channel.GuideNumber,
      channel.GuideName,
      channel.Affiliate || null,
      channel.ImageURL || null,
      channel.GuideNumber // Using guide_number as channel_id for simplicity
    ]);

    // Get the channel ID
    const results = await db.run('SELECT id FROM guide_channels WHERE guide_number = ?', [channel.GuideNumber]);
    return results[0].id;
  }

  /**
   * Cache program information in database
   */
  async cacheProgram(channelId, program) {
    await db.run(`
      INSERT INTO guide_programs (
        channel_id, series_id, title, episode_number, episode_title,
        synopsis, start_time, end_time, original_airdate, image_url, filters, last_updated
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(channel_id, series_id, start_time) DO UPDATE SET
        title = excluded.title,
        episode_number = excluded.episode_number,
        episode_title = excluded.episode_title,
        synopsis = excluded.synopsis,
        end_time = excluded.end_time,
        original_airdate = excluded.original_airdate,
        image_url = excluded.image_url,
        filters = excluded.filters,
        last_updated = CURRENT_TIMESTAMP
      WHERE channel_id = excluded.channel_id AND series_id = excluded.series_id AND start_time = excluded.start_time
    `, [
      channelId,
      program.SeriesID,
      program.Title,
      program.EpisodeNumber || null,
      program.EpisodeTitle || null,
      program.Synopsis || null,
      program.StartTime,
      program.EndTime,
      program.OriginalAirdate || null,
      program.ImageURL || null,
      program.Filter ? JSON.stringify(program.Filter) : null
    ]);
  }

  /**
   * Refresh guide data from cloud and cache it
   */
  async refreshGuideCache(options = {}) {
    console.log('[Guide] Refreshing guide data from cloud API...');

    const guideData = await this.fetchGuideFromCloud(options);

    // Cache all channels and programs
    for (const channel of guideData) {
      const channelId = await this.cacheChannel(channel);

      if (channel.Guide && channel.Guide.length > 0) {
        for (const program of channel.Guide) {
          await this.cacheProgram(channelId, program);
        }
      }
    }

    console.log(`[Guide] Cached guide data for ${guideData.length} channels`);
  }

  /**
   * Get guide data with automatic refresh if stale
   * Returns only recent/upcoming programs (not full historical cache)
   */
  async getGuide(options = {}) {
    const { forceRefresh = false } = options;

    // Check if refresh needed
    const isFresh = await this.isGuideFresh();
    if (forceRefresh || !isFresh) {
      await this.refreshGuideCache(options);
    }

    // Query database for recent/upcoming programs only
    const now = Math.floor(Date.now() / 1000);
    const endWindow = now + (24 * 3600); // Next 24 hours

    const programs = await db.run(`
      SELECT
        c.guide_number,
        c.guide_name,
        c.affiliate,
        c.image_url as channel_image,
        p.series_id,
        p.title,
        p.episode_number,
        p.episode_title,
        p.synopsis,
        p.start_time,
        p.end_time,
        p.duration,
        p.original_airdate,
        p.image_url as program_image,
        p.filters
      FROM guide_programs p
      JOIN guide_channels c ON p.channel_id = c.id
      WHERE p.start_time < ? AND p.end_time > ?
      ORDER BY c.guide_number, p.start_time
    `, [endWindow, now]);

    // Group by channel
    const guideByChannel = {};
    for (const program of programs) {
      const channelKey = program.guide_number;

      if (!guideByChannel[channelKey]) {
        guideByChannel[channelKey] = {
          GuideNumber: program.guide_number,
          GuideName: program.guide_name,
          Affiliate: program.affiliate,
          ImageURL: program.channel_image,
          Guide: []
        };
      }

      guideByChannel[channelKey].Guide.push({
        SeriesID: program.series_id,
        Title: program.title,
        EpisodeNumber: program.episode_number,
        EpisodeTitle: program.episode_title,
        Synopsis: program.synopsis,
        StartTime: program.start_time,
        EndTime: program.end_time,
        Duration: program.duration,
        OriginalAirdate: program.original_airdate,
        ImageURL: program.program_image,
        Filter: program.filters ? JSON.parse(program.filters) : []
      });
    }

    return Object.values(guideByChannel);
  }

  /**
   * Search guide data
   */
  async searchGuide(query, options = {}) {
    const { channel = null, limit = 50 } = options;

    const now = Math.floor(Date.now() / 1000);
    const endWindow = now + (7 * 24 * 3600); // Next 7 days for search

    let sql = `
      SELECT
        c.guide_number,
        c.guide_name,
        p.series_id,
        p.title,
        p.episode_number,
        p.episode_title,
        p.synopsis,
        p.start_time,
        p.end_time,
        p.image_url
      FROM guide_programs p
      JOIN guide_channels c ON p.channel_id = c.id
      WHERE (p.title LIKE ? OR p.episode_title LIKE ? OR p.synopsis LIKE ?)
        AND p.start_time < ? AND p.end_time > ?
    `;

    const params = [`%${query}%`, `%${query}%`, `%${query}%`, endWindow, now];

    if (channel) {
      sql += ' AND c.guide_number = ?';
      params.push(channel);
    }

    sql += ' ORDER BY p.start_time LIMIT ?';
    params.push(limit);

    return await db.run(sql, params);
  }

  /**
   * Get what's on now across all channels
   */
  async getCurrentPrograms() {
    const now = Math.floor(Date.now() / 1000);

    return await db.run(`
      SELECT
        c.guide_number,
        c.guide_name,
        c.affiliate,
        p.series_id,
        p.title,
        p.episode_number,
        p.episode_title,
        p.start_time,
        p.end_time,
        p.image_url
      FROM guide_programs p
      JOIN guide_channels c ON p.channel_id = c.id
      WHERE p.start_time <= ? AND p.end_time > ?
      ORDER BY c.guide_number
    `, [now, now]);
  }

  /**
   * Get program by SeriesID (useful for recording setup)
   */
  async getProgramBySeriesId(seriesId) {
    const results = await db.run(`
      SELECT
        c.guide_number,
        c.guide_name,
        p.series_id,
        p.title,
        p.episode_number,
        p.episode_title,
        p.synopsis,
        p.image_url
      FROM guide_programs p
      JOIN guide_channels c ON p.channel_id = c.id
      WHERE p.series_id = ?
      LIMIT 1
    `, [seriesId]);

    return results && results.length > 0 ? results[0] : null;
  }

  /**
   * Initialize guide manager - load guide data on startup
   */
  async initialize() {
    console.log('[Guide] Initializing guide manager...');

    try {
      // Check if we have fresh data
      const isFresh = await this.isGuideFresh();

      if (!isFresh) {
        console.log('[Guide] No fresh guide data found, loading from cloud...');
        await this.refreshGuideCache();
      } else {
        console.log('[Guide] Guide data is fresh, skipping initial load');
      }

      // Start periodic refresh (every 12 hours)
      this.startPeriodicRefresh();

      console.log('[Guide] Guide manager initialized');
    } catch (error) {
      console.error('[Guide] Failed to initialize guide manager:', error.message);
      // Don't throw - let the server start even if guide fails
      // Will retry on next periodic refresh
    }
  }

  /**
   * Start periodic background refresh
   */
  startPeriodicRefresh() {
    // Clear any existing timer
    if (this.refreshTimer) {
      clearInterval(this.refreshTimer);
    }

    // Refresh every 12 hours
    const refreshInterval = 12 * 60 * 60 * 1000; // 12 hours in milliseconds

    this.refreshTimer = setInterval(async () => {
      try {
        console.log('[Guide] Running periodic guide refresh...');
        await this.refreshGuideCache();
      } catch (error) {
        console.error('[Guide] Periodic refresh failed:', error.message);
      }
    }, refreshInterval);

    console.log('[Guide] Periodic refresh scheduled (every 12 hours)');
  }

  /**
   * Stop periodic refresh (for cleanup)
   */
  stopPeriodicRefresh() {
    if (this.refreshTimer) {
      clearInterval(this.refreshTimer);
      this.refreshTimer = null;
      console.log('[Guide] Periodic refresh stopped');
    }
  }
}

module.exports = new GuideManager();
