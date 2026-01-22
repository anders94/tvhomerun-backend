/**
 * Recording Rules Module
 * Manages DVR recording rules via HDHomeRun cloud API
 *
 * Strategy:
 * - Cloud API is source of truth for recording rules
 * - Local cache updated after every mutation
 * - Device notified to sync after every change
 * - Recording rules fetched fresh on each list operation (they change infrequently)
 */

const axios = require('axios');
const db = require('asynqlite');

class RecordingRulesManager {
  constructor() {
    this.cloudApiBase = 'https://api.hdhomerun.com/api/recording_rules';
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
   * Refresh device_auth token by fetching fresh data from device
   */
  async refreshDeviceAuth() {
    console.log('Refreshing device_auth token from device...');

    // Get device IP address
    const devices = await db.run('SELECT device_id, ip_address FROM devices WHERE ip_address IS NOT NULL LIMIT 1');
    if (!devices || devices.length === 0) {
      throw new Error('No devices found with IP address');
    }

    const device = devices[0];

    try {
      // Fetch fresh device info from the device
      const response = await axios.get(`http://${device.ip_address}/discover.json`, {
        timeout: 5000
      });

      const newDeviceAuth = response.data.DeviceAuth;
      if (!newDeviceAuth) {
        throw new Error('Device did not return DeviceAuth token');
      }

      // Update database
      await db.run(
        'UPDATE devices SET device_auth = ?, updated_at = CURRENT_TIMESTAMP WHERE device_id = ?',
        [newDeviceAuth, device.device_id]
      );

      console.log(`Device_auth refreshed successfully for device ${device.device_id}`);
      return newDeviceAuth;
    } catch (error) {
      console.error(`Failed to refresh device_auth: ${error.message}`);
      throw new Error(`Unable to refresh device authentication: ${error.message}`);
    }
  }

  /**
   * Wrapper for cloud API calls with automatic 403 retry
   * If a 403 error occurs, refreshes device_auth and retries once
   */
  async callCloudApiWithRetry(apiCallFn) {
    try {
      return await apiCallFn();
    } catch (error) {
      // Check if it's a 403 error from the cloud API
      if (error.response && error.response.status === 403) {
        console.log('Received 403 from cloud API, attempting to refresh device_auth and retry...');

        try {
          // Refresh the device_auth token
          await this.refreshDeviceAuth();

          // Retry the API call once with the new token
          return await apiCallFn();
        } catch (retryError) {
          console.error('Retry after device_auth refresh failed:', retryError.message);
          throw retryError;
        }
      }

      // For non-403 errors, just throw them
      throw error;
    }
  }

  /**
   * Get all devices for syncing
   */
  async getAllDevices() {
    return await db.run('SELECT device_id, ip_address, base_url FROM devices WHERE ip_address IS NOT NULL');
  }

  /**
   * Sync recording rules with device
   * Notifies device to fetch updated rules from cloud
   */
  async syncDevice(deviceIp) {
    try {
      await axios.post(`http://${deviceIp}/recording_events.post?sync`, null, {
        timeout: 5000
      });
      console.log(`Synced recording rules with device at ${deviceIp}`);
      return true;
    } catch (error) {
      console.error(`Failed to sync device at ${deviceIp}:`, error.message);
      return false;
    }
  }

  /**
   * Sync all devices after rule change
   */
  async syncAllDevices() {
    const devices = await this.getAllDevices();

    const syncResults = await Promise.allSettled(
      devices.map(device => this.syncDevice(device.ip_address))
    );

    const successful = syncResults.filter(r => r.status === 'fulfilled' && r.value === true).length;
    console.log(`Synced ${successful}/${devices.length} devices`);

    return { total: devices.length, successful };
  }

  /**
   * Fetch recording rules from cloud API
   */
  async fetchRulesFromCloud() {
    return await this.callCloudApiWithRetry(async () => {
      const deviceAuth = await this.getDeviceAuth();

      const response = await axios.get(this.cloudApiBase, {
        params: { DeviceAuth: deviceAuth },
        timeout: 10000
      });

      return response.data || [];
    });
  }

  /**
   * Cache recording rule in database
   */
  async cacheRule(rule) {
    await db.run(`
      INSERT INTO recording_rules (
        recording_rule_id, series_id, title, synopsis, image_url,
        channel_only, team_only, recent_only, after_original_airdate_only,
        date_time_only, priority, start_padding, end_padding, last_synced
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(recording_rule_id) DO UPDATE SET
        title = excluded.title,
        synopsis = excluded.synopsis,
        image_url = excluded.image_url,
        channel_only = excluded.channel_only,
        team_only = excluded.team_only,
        recent_only = excluded.recent_only,
        after_original_airdate_only = excluded.after_original_airdate_only,
        date_time_only = excluded.date_time_only,
        priority = excluded.priority,
        start_padding = excluded.start_padding,
        end_padding = excluded.end_padding,
        last_synced = CURRENT_TIMESTAMP,
        updated_at = CURRENT_TIMESTAMP
    `, [
      rule.RecordingRuleID,
      rule.SeriesID,
      rule.Title || null,
      rule.Synopsis || null,
      rule.ImageURL || null,
      rule.ChannelOnly || null,
      rule.TeamOnly || null,
      rule.RecentOnly || 0,
      rule.AfterOriginalAirdateOnly || null,
      rule.DateTimeOnly || null,
      rule.Priority || null,
      rule.StartPadding || 30,
      rule.EndPadding || 30
    ]);
  }

  /**
   * List all recording rules (fetches fresh from cloud)
   */
  async listRules() {
    const rules = await this.fetchRulesFromCloud();

    // Update local cache
    for (const rule of rules) {
      await this.cacheRule(rule);
    }

    // Remove deleted rules from cache
    if (rules.length > 0) {
      const ruleIds = rules.map(r => r.RecordingRuleID);
      const placeholders = ruleIds.map(() => '?').join(',');
      await db.run(`
        DELETE FROM recording_rules
        WHERE recording_rule_id NOT IN (${placeholders})
      `, ruleIds);
    }

    return rules;
  }

  /**
   * Create or update a recording rule
   */
  async createRule(params) {
    const response = await this.callCloudApiWithRetry(async () => {
      const deviceAuth = await this.getDeviceAuth();

      // Prepare request body
      const formData = new URLSearchParams({
        DeviceAuth: deviceAuth,
        Cmd: 'add',
        ...params
      });

      // Call cloud API
      return await axios.post(this.cloudApiBase, formData, {
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        timeout: 10000
      });
    });

    // Sync devices
    await this.syncAllDevices();

    // Refresh cache
    await this.listRules();

    return response.data;
  }

  /**
   * Delete a recording rule
   */
  async deleteRule(recordingRuleId) {
    const response = await this.callCloudApiWithRetry(async () => {
      const deviceAuth = await this.getDeviceAuth();

      const formData = new URLSearchParams({
        DeviceAuth: deviceAuth,
        Cmd: 'delete',
        RecordingRuleID: recordingRuleId
      });

      return await axios.post(this.cloudApiBase, formData, {
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        timeout: 10000
      });
    });

    // Sync devices
    await this.syncAllDevices();

    // Remove from cache
    await db.run('DELETE FROM recording_rules WHERE recording_rule_id = ?', [recordingRuleId]);

    return response.data;
  }

  /**
   * Change recording rule priority
   */
  async changePriority(recordingRuleId, afterRecordingRuleId) {
    const response = await this.callCloudApiWithRetry(async () => {
      const deviceAuth = await this.getDeviceAuth();

      const formData = new URLSearchParams({
        DeviceAuth: deviceAuth,
        Cmd: 'change',
        RecordingRuleID: recordingRuleId,
        AfterRecordingRuleID: afterRecordingRuleId
      });

      return await axios.post(this.cloudApiBase, formData, {
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        timeout: 10000
      });
    });

    // Sync devices
    await this.syncAllDevices();

    // Refresh cache
    await this.listRules();

    return response.data;
  }

  /**
   * Get recording rule from cache by ID
   */
  async getRuleById(recordingRuleId) {
    const results = await db.run(`
      SELECT * FROM recording_rules_detail
      WHERE recording_rule_id = ?
    `, [recordingRuleId]);

    return results && results.length > 0 ? results[0] : null;
  }

  /**
   * Get recording rules by SeriesID
   */
  async getRulesBySeriesId(seriesId) {
    return await db.run(`
      SELECT * FROM recording_rules
      WHERE series_id = ?
      ORDER BY priority ASC
    `, [seriesId]);
  }

  /**
   * Check if a series has an active recording rule
   */
  async hasRecordingRule(seriesId) {
    const results = await db.run(`
      SELECT COUNT(*) as count
      FROM recording_rules
      WHERE series_id = ?
    `, [seriesId]);

    return results && results.length > 0 && results[0].count > 0;
  }
}

module.exports = new RecordingRulesManager();
