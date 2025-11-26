#!/usr/bin/env node

const axios = require('axios');
const HDHomeRunDatabase = require('./database');

/**
 * Command-line tool for comparing local database progress against HDHomeRun device progress
 *
 * Usage:
 *   node src/compare-progress.js [--sync-mismatched] [--verbose]
 *
 * Examples:
 *   node src/compare-progress.js
 *   node src/compare-progress.js --sync-mismatched
 *   node src/compare-progress.js --verbose
 */

class CompareProgressTool {
  constructor() {
    this.database = new HDHomeRunDatabase();
    this.verbose = process.argv.includes('--verbose') || process.env.DEBUG === '1';
    this.syncMismatched = process.argv.includes('--sync-mismatched');

    // Cache for series episodes data to minimize device requests
    this.seriesCache = new Map();

    // Statistics
    this.stats = {
      total: 0,
      inSync: 0,
      outOfSync: 0,
      errors: 0,
      synced: 0
    };
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

  /**
   * Get all episodes for a series from the device (with caching)
   */
  async getSeriesEpisodesFromDevice(seriesId) {
    // Check cache first
    if (this.seriesCache.has(seriesId)) {
      return this.seriesCache.get(seriesId);
    }

    try {
      const series = await this.database.getSeriesById(seriesId);

      if (!series || !series.episodes_url) {
        throw new Error('Series episodes URL not found');
      }

      this.log(`Fetching episodes for series: ${series.title}`);
      const response = await axios.get(series.episodes_url, { timeout: 10000 });

      if (response.data && Array.isArray(response.data)) {
        // Cache the result
        this.seriesCache.set(seriesId, response.data);
        return response.data;
      }

      throw new Error('Invalid response from device');
    } catch (error) {
      // Cache the error so we don't retry for this series
      this.seriesCache.set(seriesId, null);
      throw error;
    }
  }

  /**
   * Compare a single episode
   */
  async compareEpisode(episode) {
    this.stats.total++;

    try {
      // Get series episodes from device (cached)
      const seriesEpisodes = await this.getSeriesEpisodesFromDevice(episode.series_id);

      if (!seriesEpisodes) {
        throw new Error('Could not fetch series data');
      }

      // Find the matching episode by ProgramID
      const deviceEpisode = seriesEpisodes.find(e => e.ProgramID === episode.program_id);

      if (!deviceEpisode) {
        throw new Error('Episode not found on device');
      }

      // Compare values
      const deviceResume = deviceEpisode.Resume === 4294967295 ? episode.duration : (deviceEpisode.Resume || 0);
      const deviceWatched = deviceEpisode.Resume === 4294967295;
      const dbResume = episode.resume_position || 0;
      const dbWatched = !!episode.watched;

      const inSync = deviceResume === dbResume && deviceWatched === dbWatched;

      if (inSync) {
        this.stats.inSync++;
        return {
          success: true,
          inSync: true,
          deviceResume,
          deviceWatched,
          dbResume,
          dbWatched
        };
      } else {
        this.stats.outOfSync++;
        return {
          success: true,
          inSync: false,
          deviceResume,
          deviceWatched,
          dbResume,
          dbWatched
        };
      }
    } catch (error) {
      this.stats.errors++;
      return {
        success: false,
        error: error.message
      };
    }
  }

  /**
   * Format duration for display
   */
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

  /**
   * Print a single line for an episode
   */
  printEpisodeLine(episode, result) {
    const id = String(episode.id).padEnd(6);
    const series = (episode.series_title || '').substring(0, 28).padEnd(30);
    const title = (episode.episode_title || episode.title || '').substring(0, 28).padEnd(30);

    if (!result.success) {
      const status = `ERROR: ${result.error}`.padEnd(40);
      console.log(`${id} ${series} ${title} ${status}`);
    } else if (result.inSync) {
      const status = '✓ IN SYNC'.padEnd(40);
      console.log(`${id} ${series} ${title} ${status}`);
    } else {
      const dbPos = this.formatDuration(result.dbResume);
      const devicePos = this.formatDuration(result.deviceResume);
      const status = `✗ OUT OF SYNC (DB: ${dbPos}, Device: ${devicePos})`.padEnd(40);
      console.log(`${id} ${series} ${title} ${status}`);
    }
  }

  async run() {
    try {
      await this.initialize();

      console.log('\n=== Comparing Local Database with HDHomeRun Device ===\n');

      if (this.syncMismatched) {
        console.log('Mode: Compare and sync mismatched episodes\n');
      } else {
        console.log('Mode: Compare only (use --sync-mismatched to fix)\n');
      }

      // Get all episodes
      console.log('Fetching all episodes from database...');
      const allEpisodes = await this.database.getAllEpisodes();

      if (allEpisodes.length === 0) {
        console.log('No episodes found in database.\n');
        return true;
      }

      console.log(`Found ${allEpisodes.length} episodes. Comparing...\n`);

      // Print header
      console.log(`${'ID'.padEnd(6)} ${'Series'.padEnd(30)} ${'Episode'.padEnd(30)} ${'Status'.padEnd(40)}`);
      console.log('-'.repeat(110));

      // Compare each episode
      const mismatched = [];
      for (const episode of allEpisodes) {
        const result = await this.compareEpisode(episode);
        this.printEpisodeLine(episode, result);

        // Track mismatched episodes for potential sync
        if (result.success && !result.inSync) {
          mismatched.push({ episode, result });
        }

        // Small delay to avoid overwhelming the device
        if (this.stats.total % 10 === 0) {
          await new Promise(resolve => setTimeout(resolve, 100));
        }
      }

      // Print summary
      console.log('-'.repeat(110));
      console.log(`\n=== Summary ===`);
      console.log(`Total Episodes:    ${this.stats.total}`);
      console.log(`In Sync:           ${this.stats.inSync} (${Math.round((this.stats.inSync / this.stats.total) * 100)}%)`);
      console.log(`Out of Sync:       ${this.stats.outOfSync}`);
      console.log(`Errors:            ${this.stats.errors}`);

      // Sync mismatched episodes if requested
      if (this.syncMismatched && mismatched.length > 0) {
        console.log(`\n=== Syncing ${mismatched.length} Mismatched Episodes ===\n`);

        for (const { episode, result } of mismatched) {
          try {
            await this.database.updateEpisodeProgress(
              episode.id,
              result.deviceResume,
              result.deviceWatched
            );
            console.log(`✓ Synced episode ${episode.id}: ${episode.series_title} - ${episode.episode_title}`);
            this.stats.synced++;
          } catch (error) {
            console.log(`✗ Failed to sync episode ${episode.id}: ${error.message}`);
          }
        }

        console.log(`\nSynced ${this.stats.synced} of ${mismatched.length} episodes`);
      } else if (mismatched.length > 0) {
        console.log(`\nTip: Run with --sync-mismatched to automatically update the database from device values`);
      }

      console.log('');
      return true;
    } catch (error) {
      console.error(`\nError: ${error.message}`);
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
HDHomeRun Progress Compare Tool

Compares playback progress between the local database and HDHomeRun devices
for all episodes. Shows which episodes are in sync and which are not.

Usage:
  node src/compare-progress.js [options]

Options:
  --sync-mismatched    Automatically sync mismatched episodes from device to database
  --verbose            Show detailed debug output
  --help               Show this help message

Examples:
  # Compare all episodes (read-only)
  node src/compare-progress.js

  # Compare and sync mismatched episodes
  node src/compare-progress.js --sync-mismatched

  # Compare with verbose output
  node src/compare-progress.js --verbose

Output:
  Each line shows:
  - Episode ID
  - Series name
  - Episode title
  - Sync status (✓ IN SYNC, ✗ OUT OF SYNC, or ERROR)

Notes:
  - Episodes are grouped by series to minimize device requests
  - Progress values are cached per series for efficiency
  - Errors may occur if recordings have been deleted from the device
  - Use --sync-mismatched carefully - it will overwrite local database values
`);
  }
}

// Run if called directly
if (require.main === module) {
  const args = process.argv.slice(2);

  if (args.includes('--help') || args.includes('-h')) {
    const tool = new CompareProgressTool();
    tool.printUsage();
    process.exit(0);
  }

  const tool = new CompareProgressTool();
  tool.run().then(success => {
    process.exit(success ? 0 : 1);
  });
}

module.exports = CompareProgressTool;
