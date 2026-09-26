#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const db = require('asynqlite');
const HDHomeRunDatabase = require('./database');

/**
 * Restore recordings whose only remaining copy is an HLS cache directory.
 *
 * After the HDHomeRun's drive failed, discovery pruned the database rows for
 * every recording the device no longer listed, while the transcoded copies in
 * hls-cache/ survived. This tool walks a cache directory, and for every
 * {episodeId}/ whose id is missing from the live database, re-inserts the
 * episode (and its series) from a backup of the database, flags it as not on
 * the device, and moves the directory into the live cache.
 *
 * Cache directories that already have a live database row are just moved into
 * place. Directories with no row in the backup either are left where they are
 * and reported.
 *
 * Usage:
 *   node src/restore-cached-episodes.js <backup.db> <old-cache-dir> [--dry-run]
 *
 * Run with the server stopped: it only scans the cache directory at startup.
 */

async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const [backupPath, oldCacheDir] = args.filter(a => !a.startsWith('--'));

  if (!backupPath || !oldCacheDir) {
    console.error('Usage: node src/restore-cached-episodes.js <backup.db> <old-cache-dir> [--dry-run]');
    process.exit(1);
  }
  if (!fs.existsSync(backupPath)) {
    console.error(`Backup database not found: ${backupPath}`);
    process.exit(1);
  }
  if (!fs.existsSync(oldCacheDir)) {
    console.error(`Cache directory not found: ${oldCacheDir}`);
    process.exit(1);
  }

  const liveCacheDir = process.env.HLS_CACHE_DIR || path.join(__dirname, '../hls-cache');
  const now = new Date().toISOString();

  const database = new HDHomeRunDatabase();
  await database.initialize();
  await db.run(`ATTACH DATABASE ? AS backup`, [path.resolve(backupPath)]);

  // Columns present in both databases, skipping generated ones (can't be inserted)
  const insertableColumns = async (table) => {
    const live = await db.run(`PRAGMA main.table_xinfo(${table})`);
    const bak = await db.run(`PRAGMA backup.table_xinfo(${table})`);
    const bakNames = new Set(bak.filter(c => !c.hidden).map(c => c.name));
    return live.filter(c => !c.hidden && bakNames.has(c.name)).map(c => c.name);
  };
  const episodeColumns = (await insertableColumns('episodes')).filter(c => c !== 'device_missing_since' && c !== 'recording_id');
  const seriesColumns = await insertableColumns('series');

  const entries = fs.readdirSync(oldCacheDir)
    .filter(name => /^\d+$/.test(name) && fs.statSync(path.join(oldCacheDir, name)).isDirectory())
    .sort((a, b) => parseInt(a, 10) - parseInt(b, 10));

  const summary = { restored: 0, seriesRestored: 0, moved: 0, replaced: 0, keptExisting: 0, noBackupRow: [], seriesConflict: [] };

  const cacheState = (dir) => {
    try {
      return JSON.parse(fs.readFileSync(path.join(dir, 'transcode.json'), 'utf8')).state;
    } catch (error) {
      return null;
    }
  };

  const moveDir = (id) => {
    const from = path.join(oldCacheDir, id);
    const to = path.join(liveCacheDir, id);
    if (fs.existsSync(to)) {
      // Prefer a complete copy over whatever is already there
      if (cacheState(from) === 'complete' && cacheState(to) !== 'complete') {
        console.log(`  replacing incomplete live cache ${id} with complete copy`);
        if (!dryRun) {
          fs.rmSync(to, { recursive: true, force: true });
          fs.renameSync(from, to);
        }
        summary.replaced++;
      } else {
        console.log(`  live cache ${id} already exists, leaving old copy in place`);
        summary.keptExisting++;
      }
      return;
    }
    if (!dryRun) fs.renameSync(from, to);
    summary.moved++;
  };

  for (const id of entries) {
    const live = await db.run('SELECT id FROM main.episodes WHERE id = ?', [id]);
    if (live && live.length > 0) {
      console.log(`Episode ${id}: exists in live database, moving cache only`);
      moveDir(id);
      continue;
    }

    const bak = await db.run('SELECT id, series_id, title, episode_title FROM backup.episodes WHERE id = ?', [id]);
    if (!bak || bak.length === 0) {
      console.log(`Episode ${id}: no row in backup either, leaving in place`);
      summary.noBackupRow.push(id);
      continue;
    }
    const episode = bak[0];

    // Make sure the series row exists with the same id (episodes.series_id points at it)
    const liveSeries = await db.run('SELECT id, series_id, device_id FROM main.series WHERE id = ?', [episode.series_id]);
    const bakSeries = await db.run('SELECT id, series_id, device_id, title FROM backup.series WHERE id = ?', [episode.series_id]);
    if (!bakSeries || bakSeries.length === 0) {
      console.log(`Episode ${id}: series ${episode.series_id} missing from backup, skipping`);
      summary.seriesConflict.push(id);
      continue;
    }
    if (liveSeries && liveSeries.length > 0) {
      if (liveSeries[0].series_id !== bakSeries[0].series_id || liveSeries[0].device_id !== bakSeries[0].device_id) {
        console.log(`Episode ${id}: live series ${episode.series_id} is a different show, skipping`);
        summary.seriesConflict.push(id);
        continue;
      }
    } else {
      const device = await db.run('SELECT id FROM main.devices WHERE id = ?', [bakSeries[0].device_id]);
      if (!device || device.length === 0) {
        console.log(`Episode ${id}: device ${bakSeries[0].device_id} missing from live database, skipping`);
        summary.seriesConflict.push(id);
        continue;
      }
      console.log(`  restoring series ${episode.series_id}: ${bakSeries[0].title}`);
      if (!dryRun) {
        const cols = seriesColumns.join(', ');
        await db.run(`INSERT INTO main.series (${cols}) SELECT ${cols} FROM backup.series WHERE id = ?`, [episode.series_id]);
      }
      summary.seriesRestored++;
    }

    console.log(`Episode ${id}: restoring "${episode.title} - ${episode.episode_title}" (flagged not on device)`);
    if (!dryRun) {
      const cols = episodeColumns.join(', ');
      await db.run(
        `INSERT INTO main.episodes (${cols}, device_missing_since) SELECT ${cols}, ? FROM backup.episodes WHERE id = ?`,
        [now, id]
      );
    }
    summary.restored++;
    moveDir(id);
  }

  if (!dryRun) {
    await database.backfillRecordingIds();
    await database.recalculateSeriesStats();
  }
  await db.run('DETACH DATABASE backup');
  await database.close();

  console.log('');
  console.log(`${dryRun ? '[DRY RUN] ' : ''}Done:`);
  console.log(`  episodes restored:      ${summary.restored}`);
  console.log(`  series restored:        ${summary.seriesRestored}`);
  console.log(`  cache dirs moved:       ${summary.moved}`);
  console.log(`  live caches replaced:   ${summary.replaced}`);
  console.log(`  left in old dir:        ${summary.keptExisting + summary.noBackupRow.length + summary.seriesConflict.length}`);
  if (summary.noBackupRow.length) console.log(`    no backup row:        ${summary.noBackupRow.join(', ')}`);
  if (summary.seriesConflict.length) console.log(`    series conflict:      ${summary.seriesConflict.join(', ')}`);
}

main().catch(error => {
  console.error(`Restore failed: ${error.message}`);
  process.exit(1);
});
