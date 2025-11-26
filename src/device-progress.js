#!/usr/bin/env node

const axios = require('axios');
const HDHomeRunDatabase = require('./database');

/**
 * Command-line tool for managing episode playback progress directly on HDHomeRun devices
 *
 * Usage:
 *   node src/device-progress.js get <episodeId>
 *   node src/device-progress.js set <episodeId> <position> [watched]
 *   node src/device-progress.js sync <episodeId>
 *
 * Examples:
 *   node src/device-progress.js get 123
 *   node src/device-progress.js set 123 1800
 *   node src/device-progress.js set 123 3600 1
 *   node src/device-progress.js sync 123
 */

class DeviceProgressTool {
  constructor() {
    this.database = new HDHomeRunDatabase();
    this.verbose = process.env.DEBUG === '1' || process.env.VERBOSE === '1';
  }

  async initialize() {
    await this.database.initialize();
  }

  async close() {
    await this.database.close();
  }

  log(message) {
    if (this.verbose) {
      console.log(`[DEBUG] ${message}`);
    }
  }

  formatDuration(seconds) {
    if (!seconds) return '0:00';
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    const secs = seconds % 60;

    if (hours > 0) {
      return `${hours}:${String(minutes).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
    }
    return `${minutes}:${String(secs).padStart(2, '0')}`;
  }

  formatDate(timestamp) {
    if (!timestamp) return 'N/A';
    const date = new Date(timestamp * 1000);
    return date.toLocaleDateString() + ' ' + date.toLocaleTimeString();
  }

  /**
   * Get progress from HDHomeRun device
   * Attempts to read the Resume field from the recorded file metadata
   */
  async getProgressFromDevice(episode) {
    if (!episode.play_url && !episode.cmd_url) {
      throw new Error('Episode has no play URL or command URL');
    }

    try {
      this.log(`Fetching episode data from device...`);

      // We need the series episodes_url to get the current episode list
      // First, get the series information from the database
      const series = await this.database.getSeriesById(episode.series_id);

      if (!series || !series.episodes_url) {
        throw new Error('Series episodes URL not found in database');
      }

      // The episodes_url should be a full URL to the series episodes JSON
      this.log(`Fetching from: ${series.episodes_url}`);
      const response = await axios.get(series.episodes_url, { timeout: 10000 });

      if (response.data && Array.isArray(response.data)) {
        // Find the matching episode by ProgramID
        const deviceEpisode = response.data.find(e => e.ProgramID === episode.program_id);

        if (deviceEpisode) {
          this.log(`Found episode on device: ${deviceEpisode.Title}, Resume: ${deviceEpisode.Resume}`);
          return {
            resume: deviceEpisode.Resume || 0,
            recordEndTime: deviceEpisode.RecordEndTime || 0,
            success: true
          };
        }
      }

      throw new Error('Episode not found in device response');
    } catch (error) {
      if (error.code === 'ECONNREFUSED' || error.code === 'ETIMEDOUT') {
        throw new Error(`Cannot connect to HDHomeRun device`);
      }

      if (error.response && error.response.status) {
        throw new Error(`Device returned error ${error.response.status}: ${error.response.statusText}`);
      }

      throw new Error(`Failed to get progress from device: ${error.message}`);
    }
  }

  /**
   * Set progress on HDHomeRun device
   * Note: This uses undocumented APIs and may not work on all devices/firmware versions
   */
  async setProgressOnDevice(episode, position, watched = null) {
    if (!episode.cmd_url) {
      throw new Error('Episode has no command URL (cmd_url)');
    }

    try {
      this.log(`Setting progress on device via: ${episode.cmd_url}`);

      // Prepare form data
      const formData = new URLSearchParams();
      formData.append('Resume', position.toString());

      if (watched !== null) {
        // If watched is true, set Resume to special value (4294967295 = max uint32, indicates watched)
        // If watched is false, use the provided position
        if (watched) {
          formData.append('Resume', '4294967295');
        }
      }

      // Attempt to POST to the command URL
      const response = await axios.post(episode.cmd_url, formData, {
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded'
        },
        timeout: 5000
      });

      this.log(`Device response status: ${response.status}`);
      this.log(`Device response: ${JSON.stringify(response.data)}`);

      return {
        success: true,
        status: response.status,
        data: response.data
      };
    } catch (error) {
      if (error.code === 'ECONNREFUSED' || error.code === 'ETIMEDOUT') {
        throw new Error(`Cannot connect to HDHomeRun device at ${episode.cmd_url}`);
      }

      // Some devices may return errors for this undocumented API
      if (error.response) {
        throw new Error(`Device rejected request: ${error.response.status} ${error.response.statusText}`);
      }

      throw new Error(`Failed to set progress on device: ${error.message}`);
    }
  }

  async getProgress(episodeId) {
    const episode = await this.database.getEpisodeById(episodeId);

    if (!episode) {
      console.error(`Error: Episode ${episodeId} not found in database`);
      return false;
    }

    console.log('\n=== Episode Information ===');
    console.log(`Episode ID:      ${episode.id}`);
    console.log(`Series:          ${episode.series_title}`);
    console.log(`Episode:         ${episode.episode_title || episode.title}`);
    console.log(`Episode Number:  ${episode.episode_number || 'N/A'}`);
    console.log(`Air Date:        ${this.formatDate(episode.start_time)}`);
    console.log(`Duration:        ${this.formatDuration(episode.duration)}`);
    console.log(`Device:          ${episode.device_name} (${episode.device_ip})`);

    // Get progress from database
    console.log(`\n=== Local Database Progress ===`);
    console.log(`  Resume Position: ${episode.resume_position}s (${this.formatDuration(episode.resume_position)})`);
    console.log(`  Watched:         ${episode.watched ? 'Yes' : 'No'}`);

    if (episode.resume_position > 0 && episode.duration > 0) {
      const percentage = Math.round((episode.resume_position / episode.duration) * 100);
      console.log(`  Progress:        ${percentage}%`);
    }

    // Try to get progress from device
    console.log(`\n=== HDHomeRun Device Progress ===`);
    try {
      const deviceProgress = await this.getProgressFromDevice(episode);

      const deviceResume = deviceProgress.resume === 4294967295 ? episode.duration : deviceProgress.resume;
      const deviceWatched = deviceProgress.resume === 4294967295;

      console.log(`  Resume Position: ${deviceResume}s (${this.formatDuration(deviceResume)})`);
      console.log(`  Watched:         ${deviceWatched ? 'Yes' : 'No'}`);

      if (deviceResume > 0 && episode.duration > 0) {
        const percentage = Math.round((deviceResume / episode.duration) * 100);
        console.log(`  Progress:        ${percentage}%`);
      }

      // Compare database vs device (convert to same types for comparison)
      const dbWatched = !!episode.watched; // Convert to boolean
      if (deviceResume !== episode.resume_position || deviceWatched !== dbWatched) {
        console.log(`\n⚠️  Warning: Database and device progress are out of sync!`);
        console.log(`   Use 'sync' command to update database from device.`);
      } else {
        console.log(`\n✓ Database and device are in sync`);
      }
    } catch (error) {
      console.log(`  Error: ${error.message}`);
      console.log(`\nNote: Progress could not be read from device. This may be normal if:`);
      console.log(`  - The device is offline or unreachable`);
      console.log(`  - The recording has been deleted`);
      console.log(`  - The device firmware doesn't support progress tracking`);
    }

    console.log('');
    return true;
  }

  async setProgress(episodeId, position, watched = null) {
    // Validate position
    const positionNum = parseInt(position);
    if (isNaN(positionNum) || positionNum < 0) {
      console.error('Error: Position must be a non-negative number (in seconds)');
      return false;
    }

    // Get episode
    const episode = await this.database.getEpisodeById(episodeId);
    if (!episode) {
      console.error(`Error: Episode ${episodeId} not found in database`);
      return false;
    }

    // Determine watched status
    let watchedStatus = false;
    if (watched !== null) {
      watchedStatus = watched === 'true' || watched === '1' || watched === true;
    }

    console.log('\n=== Setting Progress on HDHomeRun Device ===');
    console.log(`Episode ID:      ${episode.id}`);
    console.log(`Series:          ${episode.series_title}`);
    console.log(`Episode:         ${episode.episode_title || episode.title}`);
    console.log(`\nNew Progress:`);
    console.log(`  Resume Position: ${positionNum}s (${this.formatDuration(positionNum)})`);
    console.log(`  Watched:         ${watchedStatus ? 'Yes' : 'No'}`);
    console.log('');

    // Try to set progress on device
    try {
      const result = await this.setProgressOnDevice(episode, positionNum, watchedStatus);
      console.log('✓ Progress set successfully on HDHomeRun device\n');

      // Also update local database
      console.log('Updating local database...');
      await this.database.updateEpisodeProgress(episodeId, positionNum, watchedStatus);
      console.log('✓ Local database updated\n');

      return true;
    } catch (error) {
      console.error(`✗ Failed to set progress on device: ${error.message}\n`);
      console.log('Note: The HDHomeRun progress API is not officially documented and may not');
      console.log('work on all devices or firmware versions. You can still update the local');
      console.log('database using the regular progress tool.\n');
      return false;
    }
  }

  async syncProgress(episodeId) {
    const episode = await this.database.getEpisodeById(episodeId);

    if (!episode) {
      console.error(`Error: Episode ${episodeId} not found in database`);
      return false;
    }

    console.log('\n=== Syncing Progress from HDHomeRun Device ===');
    console.log(`Episode ID:      ${episode.id}`);
    console.log(`Series:          ${episode.series_title}`);
    console.log(`Episode:         ${episode.episode_title || episode.title}`);
    console.log('');

    try {
      // Get progress from device
      console.log('Reading progress from device...');
      const deviceProgress = await this.getProgressFromDevice(episode);

      const deviceResume = deviceProgress.resume === 4294967295 ? episode.duration : deviceProgress.resume;
      const deviceWatched = deviceProgress.resume === 4294967295;

      console.log(`\nDevice Progress:`);
      console.log(`  Resume Position: ${deviceResume}s (${this.formatDuration(deviceResume)})`);
      console.log(`  Watched:         ${deviceWatched ? 'Yes' : 'No'}`);

      // Update database
      console.log('\nUpdating local database...');
      await this.database.updateEpisodeProgress(episodeId, deviceResume, deviceWatched);

      console.log('✓ Database synced with device\n');
      return true;
    } catch (error) {
      console.error(`✗ Failed to sync progress: ${error.message}\n`);
      return false;
    }
  }

  async run(args) {
    const command = args[0];

    try {
      await this.initialize();

      switch (command) {
        case 'get':
          if (args.length < 2) {
            console.error('Error: Missing episode ID');
            this.printUsage();
            return false;
          }
          return await this.getProgress(args[1]);

        case 'set':
          if (args.length < 3) {
            console.error('Error: Missing episode ID or position');
            this.printUsage();
            return false;
          }
          return await this.setProgress(args[1], args[2], args[3]);

        case 'sync':
          if (args.length < 2) {
            console.error('Error: Missing episode ID');
            this.printUsage();
            return false;
          }
          return await this.syncProgress(args[1]);

        case 'help':
        case '--help':
        case '-h':
          this.printUsage();
          return true;

        default:
          console.error(`Error: Unknown command '${command}'`);
          this.printUsage();
          return false;
      }
    } catch (error) {
      console.error(`Error: ${error.message}`);
      if (this.verbose) {
        console.error(error.stack);
      }
      return false;
    } finally {
      await this.close();
    }
  }

  printUsage() {
    console.log(`
HDHomeRun Device Progress Tool

This tool interacts directly with HDHomeRun devices to read and write
playback progress for recorded episodes.

Usage:
  node src/device-progress.js <command> [options]

Commands:
  get <episodeId>                        Get progress from device and database
  set <episodeId> <position> [watched]   Set progress on device and database
  sync <episodeId>                       Sync database from device progress

Get Command:
  node src/device-progress.js get 123

  Displays playback progress from both the local database and the HDHomeRun
  device. Shows if they are in sync.

Set Command:
  node src/device-progress.js set 123 1800
  node src/device-progress.js set 123 3600 1

  Sets the resume position on the HDHomeRun device and updates the local
  database. Position is in seconds. Optional watched flag (0/1 or true/false).

Sync Command:
  node src/device-progress.js sync 123

  Reads the current progress from the HDHomeRun device and updates the
  local database to match.

Examples:
  # Check progress for episode 42 (both device and database)
  node src/device-progress.js get 42

  # Set resume position to 30 minutes on device
  node src/device-progress.js set 42 1800

  # Mark episode as watched on device
  node src/device-progress.js set 42 3600 1

  # Sync database from device
  node src/device-progress.js sync 42

Environment:
  DEBUG=1    Show detailed debug output
  VERBOSE=1  Show detailed debug output

Notes:
  - The HDHomeRun progress API is not officially documented
  - Progress setting may not work on all devices or firmware versions
  - The device must be online and the recording must still exist
  - Resume value of 4294967295 indicates "watched" on HDHomeRun devices
`);
  }
}

// Run if called directly
if (require.main === module) {
  const args = process.argv.slice(2);

  if (args.length === 0) {
    const tool = new DeviceProgressTool();
    tool.printUsage();
    process.exit(1);
  }

  const tool = new DeviceProgressTool();
  tool.run(args).then(success => {
    process.exit(success ? 0 : 1);
  });
}

module.exports = DeviceProgressTool;
