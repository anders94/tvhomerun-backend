#!/usr/bin/env node

const HDHomeRunDatabase = require('./database');

/**
 * Command-line tool for managing episode playback progress (local database only)
 *
 * Usage:
 *   node src/progress.js get <episodeId>
 *   node src/progress.js set <episodeId> <position> [watched]
 *   node src/progress.js list [--unwatched|--in-progress|--watched]
 *
 * Examples:
 *   node src/progress.js get 123
 *   node src/progress.js set 123 1800
 *   node src/progress.js set 123 3600 true
 *   node src/progress.js list --in-progress
 */

class ProgressTool {
  constructor() {
    this.database = new HDHomeRunDatabase();
  }

  async initialize() {
    await this.database.initialize();
  }

  async close() {
    await this.database.close();
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

  async getProgress(episodeId) {
    const episode = await this.database.getEpisodeById(episodeId);

    if (!episode) {
      console.error(`Error: Episode ${episodeId} not found`);
      return false;
    }

    console.log('\n=== Episode Progress ===');
    console.log(`Episode ID:      ${episode.id}`);
    console.log(`Series:          ${episode.series_title}`);
    console.log(`Episode:         ${episode.episode_title || episode.title}`);
    console.log(`Episode Number:  ${episode.episode_number || 'N/A'}`);
    console.log(`Air Date:        ${this.formatDate(episode.start_time)}`);
    console.log(`Duration:        ${this.formatDuration(episode.duration)}`);
    console.log(`\nPlayback Status:`);
    console.log(`  Resume Position: ${episode.resume_position}s (${this.formatDuration(episode.resume_position)})`);
    console.log(`  Watched:         ${episode.watched ? 'Yes' : 'No'}`);

    if (episode.resume_position > 0 && episode.duration > 0) {
      const percentage = Math.round((episode.resume_position / episode.duration) * 100);
      console.log(`  Progress:        ${percentage}%`);
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

    // Get current episode to check if it exists
    const episode = await this.database.getEpisodeById(episodeId);
    if (!episode) {
      console.error(`Error: Episode ${episodeId} not found`);
      return false;
    }

    // Determine watched status
    let watchedStatus = episode.watched;
    if (watched !== null) {
      watchedStatus = watched === 'true' || watched === '1' || watched === true;
    }

    // Update progress
    const updatedEpisode = await this.database.updateEpisodeProgress(
      episodeId,
      positionNum,
      watchedStatus
    );

    console.log('\n=== Progress Updated ===');
    console.log(`Episode ID:      ${updatedEpisode.id}`);
    console.log(`Series:          ${updatedEpisode.series_title}`);
    console.log(`Episode:         ${updatedEpisode.episode_title || updatedEpisode.title}`);
    console.log(`\nNew Status:`);
    console.log(`  Resume Position: ${updatedEpisode.resume_position}s (${this.formatDuration(updatedEpisode.resume_position)})`);
    console.log(`  Watched:         ${updatedEpisode.watched ? 'Yes' : 'No'}`);

    if (updatedEpisode.resume_position > 0 && updatedEpisode.duration > 0) {
      const percentage = Math.round((updatedEpisode.resume_position / updatedEpisode.duration) * 100);
      console.log(`  Progress:        ${percentage}%`);
    }

    console.log('');
    return true;
  }

  async listEpisodes(filter = 'all') {
    let episodes;

    switch (filter) {
      case 'unwatched':
        // Get all episodes, filter unwatched
        episodes = await this.database.getAllEpisodes();
        episodes = episodes.filter(e => !e.watched);
        console.log('\n=== Unwatched Episodes ===\n');
        break;

      case 'in-progress':
        // Get episodes with resume position > 0 and not watched
        episodes = await this.database.getAllEpisodes();
        episodes = episodes.filter(e => e.resume_position > 0 && !e.watched);
        console.log('\n=== In-Progress Episodes ===\n');
        break;

      case 'watched':
        // Get watched episodes
        episodes = await this.database.getAllEpisodes();
        episodes = episodes.filter(e => e.watched);
        console.log('\n=== Watched Episodes ===\n');
        break;

      default:
        // Get recent episodes
        episodes = await this.database.getRecentEpisodes(50);
        console.log('\n=== Recent Episodes ===\n');
        break;
    }

    if (episodes.length === 0) {
      console.log('No episodes found.');
      console.log('');
      return true;
    }

    // Display episodes
    console.log(`${'ID'.padEnd(8)} ${'Series'.padEnd(30)} ${'Episode'.padEnd(30)} ${'Progress'.padEnd(10)} ${'Status'.padEnd(10)}`);
    console.log('-'.repeat(100));

    for (const episode of episodes) {
      const id = String(episode.id).padEnd(8);
      const series = (episode.series_title || '').substring(0, 28).padEnd(30);
      const episodeTitle = (episode.episode_title || episode.title || '').substring(0, 28).padEnd(30);

      let progress = '-';
      if (episode.resume_position > 0 && episode.duration > 0) {
        const percentage = Math.round((episode.resume_position / episode.duration) * 100);
        progress = `${percentage}%`;
      }
      progress = progress.padEnd(10);

      const status = episode.watched ? 'Watched' : (episode.resume_position > 0 ? 'In Progress' : 'Unwatched');
      const statusDisplay = status.padEnd(10);

      console.log(`${id} ${series} ${episodeTitle} ${progress} ${statusDisplay}`);
    }

    console.log(`\nTotal: ${episodes.length} episode(s)\n`);
    return true;
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

        case 'list':
          const filter = args[1]?.replace('--', '') || 'all';
          return await this.listEpisodes(filter);

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
      if (process.env.DEBUG) {
        console.error(error.stack);
      }
      return false;
    } finally {
      await this.close();
    }
  }

  printUsage() {
    console.log(`
HDHomeRun Episode Progress Tool (Local Database)

Usage:
  node src/progress.js <command> [options]

Commands:
  get <episodeId>                     Get progress for an episode
  set <episodeId> <position> [watched]    Set progress for an episode
  list [filter]                       List episodes with their progress

Get Command:
  node src/progress.js get 123

  Displays the current playback progress for episode 123.

Set Command:
  node src/progress.js set 123 1800
  node src/progress.js set 123 3600 true

  Sets the resume position to 1800 seconds (30 minutes) for episode 123.
  Optionally marks the episode as watched (true/false).

List Command:
  node src/progress.js list                List recent episodes
  node src/progress.js list --unwatched    List unwatched episodes
  node src/progress.js list --in-progress  List episodes in progress
  node src/progress.js list --watched      List watched episodes

Examples:
  # Get current progress for episode 42
  node src/progress.js get 42

  # Set resume position to 30 minutes (1800 seconds)
  node src/progress.js set 42 1800

  # Mark episode as watched and set position to end
  node src/progress.js set 42 3600 true

  # List all episodes currently in progress
  node src/progress.js list --in-progress

Note:
  This tool only updates the local database. To sync with HDHomeRun devices,
  use device-progress.js instead.

Environment:
  DEBUG=1    Show full error stack traces
`);
  }
}

// Run if called directly
if (require.main === module) {
  const args = process.argv.slice(2);

  if (args.length === 0) {
    const tool = new ProgressTool();
    tool.printUsage();
    process.exit(1);
  }

  const tool = new ProgressTool();
  tool.run(args).then(success => {
    process.exit(success ? 0 : 1);
  });
}

module.exports = ProgressTool;
