const db = require('asynqlite');
const fs = require('fs');
const path = require('path');

class HDHomeRunDatabase {
  constructor(dbPath = './tvhdhomerun.db') {
    this.dbPath = dbPath;
    this.isOpen = false;
  }

  async initialize() {
    // Open database connection
    await db.open(this.dbPath);
    this.isOpen = true;

    // Check if tables exist, if not create them
    const tables = await db.run(`
      SELECT name FROM sqlite_master
      WHERE type='table' AND name IN ('devices', 'series', 'episodes')
    `);

    if (!tables || tables.length === 0) {
      console.log('Database not found, creating schema...');
      await this.createSchema();
    } else {
      // Ensure triggers exist (for databases created before triggers were added)
      await this.ensureTriggersExist();
    }

    return db;
  }

  async createSchema() {
    // Create tables in correct order
    await db.run(`PRAGMA foreign_keys = ON`);
    
    // Create devices table
    await db.run(`
      CREATE TABLE devices (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        device_id TEXT NOT NULL UNIQUE,
        friendly_name TEXT,
        model_number TEXT,
        firmware_name TEXT,
        firmware_version TEXT,
        ip_address TEXT,
        base_url TEXT,
        storage_id TEXT,
        storage_url TEXT,
        total_space INTEGER,
        free_space INTEGER,
        device_auth TEXT,
        tuner_count INTEGER,
        last_seen DATETIME DEFAULT CURRENT_TIMESTAMP,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // Create series table
    await db.run(`
      CREATE TABLE series (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        device_id INTEGER NOT NULL,
        series_id TEXT NOT NULL,
        title TEXT NOT NULL,
        category TEXT,
        image_url TEXT,
        episodes_url TEXT,
        start_time INTEGER,
        update_id INTEGER,
        episode_count INTEGER DEFAULT 0,
        total_duration INTEGER DEFAULT 0,
        first_recorded DATETIME,
        last_recorded DATETIME,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (device_id) REFERENCES devices(id) ON DELETE CASCADE
      )
    `);

    // Create episodes table
    await db.run(`
      CREATE TABLE episodes (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        series_id INTEGER NOT NULL,
        program_id TEXT,
        title TEXT NOT NULL,
        episode_title TEXT,
        episode_number TEXT,
        season_number INTEGER,
        episode_num INTEGER,
        synopsis TEXT,
        category TEXT,
        channel_name TEXT,
        channel_number TEXT,
        channel_image_url TEXT,
        start_time INTEGER NOT NULL,
        end_time INTEGER NOT NULL,
        duration INTEGER GENERATED ALWAYS AS (end_time - start_time) STORED,
        original_airdate INTEGER,
        record_start_time INTEGER,
        record_end_time INTEGER,
        first_airing INTEGER DEFAULT 0,
        filename TEXT,
        file_size INTEGER,
        play_url TEXT,
        cmd_url TEXT,
        resume_position INTEGER DEFAULT 0,
        watched BOOLEAN DEFAULT FALSE,
        record_success INTEGER DEFAULT 1,
        image_url TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (series_id) REFERENCES series(id) ON DELETE CASCADE
      )
    `);

    // Create indices
    await db.run(`CREATE INDEX idx_devices_device_id ON devices(device_id)`);
    await db.run(`CREATE INDEX idx_devices_ip ON devices(ip_address)`);
    await db.run(`CREATE UNIQUE INDEX idx_series_device_series ON series(device_id, series_id)`);
    await db.run(`CREATE INDEX idx_series_title ON series(title)`);
    await db.run(`CREATE INDEX idx_episodes_series ON episodes(series_id)`);
    await db.run(`CREATE INDEX idx_episodes_program_id ON episodes(program_id)`);
    await db.run(`CREATE INDEX idx_episodes_start_time ON episodes(start_time)`);

    // Create triggers to maintain series statistics
    await db.run(`
      CREATE TRIGGER update_series_stats_insert
      AFTER INSERT ON episodes
      BEGIN
        UPDATE series SET
          episode_count = (SELECT COUNT(*) FROM episodes WHERE series_id = NEW.series_id),
          total_duration = (SELECT COALESCE(SUM(duration), 0) FROM episodes WHERE series_id = NEW.series_id),
          first_recorded = COALESCE(
            (SELECT MIN(start_time) FROM episodes WHERE series_id = NEW.series_id),
            first_recorded
          ),
          last_recorded = COALESCE(
            (SELECT MAX(start_time) FROM episodes WHERE series_id = NEW.series_id),
            last_recorded
          ),
          updated_at = CURRENT_TIMESTAMP
        WHERE id = NEW.series_id;
      END
    `);

    await db.run(`
      CREATE TRIGGER update_series_stats_update
      AFTER UPDATE ON episodes
      BEGIN
        UPDATE series SET
          episode_count = (SELECT COUNT(*) FROM episodes WHERE series_id = NEW.series_id),
          total_duration = (SELECT COALESCE(SUM(duration), 0) FROM episodes WHERE series_id = NEW.series_id),
          first_recorded = COALESCE(
            (SELECT MIN(start_time) FROM episodes WHERE series_id = NEW.series_id),
            first_recorded
          ),
          last_recorded = COALESCE(
            (SELECT MAX(start_time) FROM episodes WHERE series_id = NEW.series_id),
            last_recorded
          ),
          updated_at = CURRENT_TIMESTAMP
        WHERE id = NEW.series_id;
      END
    `);

    await db.run(`
      CREATE TRIGGER update_series_stats_delete
      AFTER DELETE ON episodes
      BEGIN
        UPDATE series SET
          episode_count = (SELECT COUNT(*) FROM episodes WHERE series_id = OLD.series_id),
          total_duration = (SELECT COALESCE(SUM(duration), 0) FROM episodes WHERE series_id = OLD.series_id),
          first_recorded = (SELECT MIN(start_time) FROM episodes WHERE series_id = OLD.series_id),
          last_recorded = (SELECT MAX(start_time) FROM episodes WHERE series_id = OLD.series_id),
          updated_at = CURRENT_TIMESTAMP
        WHERE id = OLD.series_id;
      END
    `);

    console.log('Database schema created successfully.');
  }

  async upsertDevice(deviceData) {
    const now = new Date().toISOString();
    
    // Check if device exists
    const existing = await db.run(
      'SELECT id FROM devices WHERE device_id = ?',
      [deviceData.DeviceID]
    );

    if (existing && existing.length > 0) {
      // Update existing device
      await db.run(`
        UPDATE devices SET
          friendly_name = ?,
          model_number = ?,
          firmware_name = ?,
          firmware_version = ?,
          ip_address = ?,
          base_url = ?,
          storage_id = ?,
          storage_url = ?,
          total_space = ?,
          free_space = ?,
          device_auth = ?,
          tuner_count = ?,
          last_seen = ?,
          updated_at = ?
        WHERE device_id = ?
      `, [
        deviceData.FriendlyName,
        deviceData.ModelNumber,
        deviceData.FirmwareName,
        deviceData.FirmwareVersion,
        deviceData.ip,
        deviceData.BaseURL,
        deviceData.StorageID,
        deviceData.StorageURL,
        deviceData.TotalSpace,
        deviceData.FreeSpace,
        deviceData.DeviceAuth,
        deviceData.TunerCount,
        now,
        now,
        deviceData.DeviceID
      ]);
      
      return existing[0].id;
    } else {
      // Insert new device
      await db.run(`
        INSERT INTO devices (
          device_id, friendly_name, model_number, firmware_name, firmware_version,
          ip_address, base_url, storage_id, storage_url, total_space, free_space,
          device_auth, tuner_count, last_seen, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `, [
        deviceData.DeviceID,
        deviceData.FriendlyName,
        deviceData.ModelNumber,
        deviceData.FirmwareName,
        deviceData.FirmwareVersion,
        deviceData.ip,
        deviceData.BaseURL,
        deviceData.StorageID,
        deviceData.StorageURL,
        deviceData.TotalSpace,
        deviceData.FreeSpace,
        deviceData.DeviceAuth,
        deviceData.TunerCount,
        now,
        now,
        now
      ]);
      
      // Get the inserted ID
      const newDevice = await db.run('SELECT last_insert_rowid() as id');
      return newDevice[0].id;
    }
  }

  async upsertSeries(deviceDbId, seriesData) {
    const now = new Date().toISOString();
    
    // Check if series exists for this device
    const existing = await db.run(
      'SELECT id FROM series WHERE device_id = ? AND series_id = ?',
      [deviceDbId, seriesData.SeriesID]
    );

    if (existing && existing.length > 0) {
      // Update existing series
      await db.run(`
        UPDATE series SET
          title = ?,
          category = ?,
          image_url = ?,
          episodes_url = ?,
          start_time = ?,
          update_id = ?,
          updated_at = ?
        WHERE id = ?
      `, [
        seriesData.Title,
        seriesData.Category,
        seriesData.ImageURL,
        seriesData.EpisodesURL,
        seriesData.StartTime,
        seriesData.UpdateID,
        now,
        existing[0].id
      ]);
      
      return existing[0].id;
    } else {
      // Insert new series
      await db.run(`
        INSERT INTO series (
          device_id, series_id, title, category, image_url, episodes_url,
          start_time, update_id, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `, [
        deviceDbId,
        seriesData.SeriesID,
        seriesData.Title,
        seriesData.Category,
        seriesData.ImageURL,
        seriesData.EpisodesURL,
        seriesData.StartTime,
        seriesData.UpdateID,
        now,
        now
      ]);
      
      const newSeries = await db.run('SELECT last_insert_rowid() as id');
      return newSeries[0].id;
    }
  }

  async upsertEpisode(seriesDbId, episodeData) {
    const now = new Date().toISOString();
    
    // Use ProgramID as unique identifier for episodes
    const existing = await db.run(
      'SELECT id FROM episodes WHERE series_id = ? AND program_id = ?',
      [seriesDbId, episodeData.ProgramID]
    );

    // Extract season and episode numbers from episode number string
    const seasonEpisode = this.parseEpisodeNumber(episodeData.EpisodeNumber);

    if (existing && existing.length > 0) {
      // Update existing episode
      await db.run(`
        UPDATE episodes SET
          title = ?,
          episode_title = ?,
          episode_number = ?,
          season_number = ?,
          episode_num = ?,
          synopsis = ?,
          category = ?,
          channel_name = ?,
          channel_number = ?,
          channel_image_url = ?,
          start_time = ?,
          end_time = ?,
          original_airdate = ?,
          record_start_time = ?,
          record_end_time = ?,
          first_airing = ?,
          filename = ?,
          play_url = ?,
          cmd_url = ?,
          resume_position = ?,
          record_success = ?,
          image_url = ?,
          updated_at = ?
        WHERE id = ?
      `, [
        episodeData.Title,
        episodeData.EpisodeTitle,
        episodeData.EpisodeNumber,
        seasonEpisode.season,
        seasonEpisode.episode,
        episodeData.Synopsis,
        episodeData.Category,
        episodeData.ChannelName,
        episodeData.ChannelNumber,
        episodeData.ChannelImageURL,
        episodeData.StartTime,
        episodeData.EndTime,
        episodeData.OriginalAirdate,
        episodeData.RecordStartTime,
        episodeData.RecordEndTime,
        episodeData.FirstAiring || 0,
        episodeData.Filename,
        episodeData.PlayURL,
        episodeData.CmdURL,
        episodeData.Resume === 4294967295 ? 0 : episodeData.Resume,
        episodeData.RecordSuccess || 1,
        episodeData.ImageURL,
        now,
        existing[0].id
      ]);
      
      return existing[0].id;
    } else {
      // Insert new episode
      await db.run(`
        INSERT INTO episodes (
          series_id, program_id, title, episode_title, episode_number,
          season_number, episode_num, synopsis, category, channel_name,
          channel_number, channel_image_url, start_time, end_time,
          original_airdate, record_start_time, record_end_time, first_airing,
          filename, play_url, cmd_url, resume_position, record_success,
          image_url, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `, [
        seriesDbId,
        episodeData.ProgramID,
        episodeData.Title,
        episodeData.EpisodeTitle,
        episodeData.EpisodeNumber,
        seasonEpisode.season,
        seasonEpisode.episode,
        episodeData.Synopsis,
        episodeData.Category,
        episodeData.ChannelName,
        episodeData.ChannelNumber,
        episodeData.ChannelImageURL,
        episodeData.StartTime,
        episodeData.EndTime,
        episodeData.OriginalAirdate,
        episodeData.RecordStartTime,
        episodeData.RecordEndTime,
        episodeData.FirstAiring || 0,
        episodeData.Filename,
        episodeData.PlayURL,
        episodeData.CmdURL,
        episodeData.Resume === 4294967295 ? 0 : episodeData.Resume,
        episodeData.RecordSuccess || 1,
        episodeData.ImageURL,
        now,
        now
      ]);
      
      const newEpisode = await db.run('SELECT last_insert_rowid() as id');
      return newEpisode[0].id;
    }
  }

  parseEpisodeNumber(episodeNumberString) {
    if (!episodeNumberString) {
      return { season: null, episode: null };
    }

    // Try to parse formats like "S05E07", "S5E7", etc.
    const match = episodeNumberString.match(/S(\d+)E(\d+)/i);
    if (match) {
      return {
        season: parseInt(match[1]),
        episode: parseInt(match[2])
      };
    }

    return { season: null, episode: null };
  }

  async syncDeviceData(deviceData, shows) {
    console.log(`Syncing data for device: ${deviceData.FriendlyName}`);
    
    // Upsert device
    const deviceDbId = await this.upsertDevice(deviceData);
    
    // Sync all series and episodes
    for (const show of shows) {
      const seriesDbId = await this.upsertSeries(deviceDbId, {
        SeriesID: show.seriesID,
        Title: show.title,
        Category: show.category,
        ImageURL: show.imageURL,
        EpisodesURL: show.episodesURL,
        StartTime: show.startTime,
        UpdateID: show.updateID
      });
      
      // Sync episodes for this series
      for (const episode of show.episodes) {
        await this.upsertEpisode(seriesDbId, {
          ProgramID: episode.programID,
          Title: episode.title,
          EpisodeTitle: episode.title, // Using episode title as both title fields
          EpisodeNumber: episode.episodeNumber,
          Synopsis: episode.synopsis,
          Category: episode.category,
          ChannelName: episode.channelName,
          ChannelNumber: episode.channelNumber,
          ChannelImageURL: episode.channelImageURL,
          StartTime: Math.floor(episode.startTime.getTime() / 1000),
          EndTime: Math.floor(episode.endTime.getTime() / 1000),
          OriginalAirdate: episode.originalAirdate ? Math.floor(episode.originalAirdate.getTime() / 1000) : null,
          RecordStartTime: episode.recordStartTime,
          RecordEndTime: episode.recordEndTime,
          FirstAiring: episode.firstAiring,
          Filename: episode.filename,
          PlayURL: episode.playURL,
          CmdURL: episode.cmdURL,
          Resume: episode.resume,
          RecordSuccess: episode.recordSuccess,
          ImageURL: episode.imageURL
        });
      }
    }
    
    console.log(`Sync completed for device: ${deviceData.FriendlyName}`);
  }

  async getDeviceStats() {
    const stats = await db.run(`
      SELECT 
        COUNT(DISTINCT d.id) as device_count,
        COUNT(DISTINCT s.id) as series_count,
        COUNT(e.id) as episode_count,
        SUM(e.duration) as total_duration_seconds
      FROM devices d
      LEFT JOIN series s ON d.id = s.device_id
      LEFT JOIN episodes e ON s.id = e.series_id
    `);

    if (stats && stats.length > 0) {
      return {
        devices: stats[0].device_count,
        series: stats[0].series_count,
        episodes: stats[0].episode_count,
        totalDurationHours: Math.round((stats[0].total_duration_seconds || 0) / 3600)
      };
    }

    return { devices: 0, series: 0, episodes: 0, totalDurationHours: 0 };
  }

  async getAllSeries() {
    const series = await db.run(`
      SELECT 
        s.id,
        s.series_id,
        s.title,
        s.category,
        s.image_url,
        s.episode_count,
        s.total_duration,
        s.first_recorded,
        s.last_recorded,
        s.created_at,
        s.updated_at,
        d.friendly_name as device_name,
        d.ip_address as device_ip
      FROM series s
      JOIN devices d ON s.device_id = d.id
      ORDER BY s.title
    `);
    
    return series || [];
  }

  async getSeriesById(seriesId) {
    const series = await db.run(`
      SELECT
        s.id,
        s.series_id,
        s.title,
        s.category,
        s.image_url,
        s.episodes_url,
        s.episode_count,
        s.total_duration,
        s.first_recorded,
        s.last_recorded,
        s.created_at,
        s.updated_at,
        d.friendly_name as device_name,
        d.ip_address as device_ip,
        d.device_id as device_device_id
      FROM series s
      JOIN devices d ON s.device_id = d.id
      WHERE s.id = ? OR s.series_id = ?
    `, [seriesId, seriesId]);

    return series && series.length > 0 ? series[0] : null;
  }

  async getEpisodesBySeriesId(seriesId) {
    const episodes = await db.run(`
      SELECT
        e.id,
        e.program_id,
        e.title,
        e.episode_title,
        e.episode_number,
        e.season_number,
        e.episode_num,
        e.synopsis,
        e.category,
        e.channel_name,
        e.channel_number,
        e.channel_image_url,
        e.start_time,
        e.end_time,
        e.duration,
        e.original_airdate,
        e.record_start_time,
        e.record_end_time,
        e.first_airing,
        e.filename,
        e.file_size,
        e.play_url,
        e.cmd_url,
        COALESCE(e.resume_position, 0) as resume_position,
        COALESCE(e.watched, 0) as watched,
        e.record_success,
        e.image_url,
        e.created_at,
        e.updated_at,
        s.series_id,
        s.title as series_title
      FROM episodes e
      JOIN series s ON e.series_id = s.id
      WHERE s.id = ? OR s.series_id = ?
      ORDER BY e.start_time DESC
    `, [seriesId, seriesId]);

    return episodes || [];
  }

  async getEpisodeById(episodeId) {
    const episodes = await db.run(`
      SELECT
        e.id,
        e.program_id,
        e.title,
        e.episode_title,
        e.episode_number,
        e.season_number,
        e.episode_num,
        e.synopsis,
        e.category,
        e.channel_name,
        e.channel_number,
        e.channel_image_url,
        e.start_time,
        e.end_time,
        e.duration,
        e.original_airdate,
        e.filename,
        e.file_size,
        e.play_url,
        e.cmd_url,
        COALESCE(e.resume_position, 0) as resume_position,
        COALESCE(e.watched, 0) as watched,
        e.record_success,
        e.image_url,
        e.created_at,
        e.updated_at,
        s.id as series_id,
        s.series_id as series_series_id,
        s.title as series_title,
        s.image_url as series_image,
        d.id as device_id,
        d.device_id as device_device_id,
        d.friendly_name as device_name,
        d.ip_address as device_ip
      FROM episodes e
      JOIN series s ON e.series_id = s.id
      JOIN devices d ON s.device_id = d.id
      WHERE e.id = ? OR e.program_id = ?
    `, [episodeId, episodeId]);

    return episodes && episodes.length > 0 ? episodes[0] : null;
  }

  async getRecentEpisodes(limit = 50) {
    const episodes = await db.run(`
      SELECT
        e.id,
        e.program_id,
        e.title,
        e.episode_title,
        e.episode_number,
        e.synopsis,
        e.category,
        e.channel_name,
        e.channel_number,
        e.start_time,
        e.end_time,
        e.duration,
        e.filename,
        e.play_url,
        COALESCE(e.resume_position, 0) as resume_position,
        COALESCE(e.watched, 0) as watched,
        e.created_at,
        s.series_id,
        s.title as series_title,
        s.image_url as series_image,
        d.friendly_name as device_name
      FROM episodes e
      JOIN series s ON e.series_id = s.id
      JOIN devices d ON s.device_id = d.id
      ORDER BY e.created_at DESC
      LIMIT ?
    `, [limit]);

    return episodes || [];
  }

  async getAllEpisodes() {
    const episodes = await db.run(`
      SELECT
        e.id,
        e.program_id,
        e.title,
        e.episode_title,
        e.episode_number,
        e.season_number,
        e.episode_num,
        e.synopsis,
        e.category,
        e.channel_name,
        e.channel_number,
        e.start_time,
        e.end_time,
        e.duration,
        e.filename,
        e.play_url,
        e.cmd_url,
        COALESCE(e.resume_position, 0) as resume_position,
        COALESCE(e.watched, 0) as watched,
        e.created_at,
        s.series_id,
        s.title as series_title,
        s.image_url as series_image,
        d.friendly_name as device_name
      FROM episodes e
      JOIN series s ON e.series_id = s.id
      JOIN devices d ON s.device_id = d.id
      ORDER BY e.created_at DESC
    `);

    return episodes || [];
  }

  async searchSeries(query) {
    const series = await db.run(`
      SELECT 
        s.id,
        s.series_id,
        s.title,
        s.category,
        s.image_url,
        s.episode_count,
        s.total_duration,
        d.friendly_name as device_name
      FROM series s
      JOIN devices d ON s.device_id = d.id
      WHERE s.title LIKE ? OR s.category LIKE ?
      ORDER BY s.title
    `, [`%${query}%`, `%${query}%`]);
    
    return series || [];
  }

  async getApiStats() {
    const stats = await db.run(`
      SELECT
        COUNT(DISTINCT d.id) as device_count,
        COUNT(DISTINCT s.id) as series_count,
        COUNT(e.id) as episode_count,
        SUM(e.duration) as total_duration_seconds,
        MAX(e.created_at) as last_updated
      FROM devices d
      LEFT JOIN series s ON d.id = s.device_id
      LEFT JOIN episodes e ON s.id = e.series_id
    `);

    if (stats && stats.length > 0) {
      return {
        devices: stats[0].device_count,
        series: stats[0].series_count,
        episodes: stats[0].episode_count,
        totalDurationHours: Math.round((stats[0].total_duration_seconds || 0) / 3600),
        lastUpdated: stats[0].last_updated
      };
    }

    return { devices: 0, series: 0, episodes: 0, totalDurationHours: 0, lastUpdated: null };
  }

  async updateEpisodeProgress(episodeId, position, watched) {
    const now = new Date().toISOString();

    // Update the episode's progress
    await db.run(`
      UPDATE episodes
      SET
        resume_position = ?,
        watched = ?,
        updated_at = ?
      WHERE id = ?
    `, [position, watched ? 1 : 0, now, episodeId]);

    // Return the updated episode
    return await this.getEpisodeById(episodeId);
  }

  async ensureTriggersExist() {
    // Check if triggers exist
    const triggers = await db.run(`
      SELECT name FROM sqlite_master
      WHERE type='trigger' AND name IN (
        'update_series_stats_insert',
        'update_series_stats_update',
        'update_series_stats_delete'
      )
    `);

    // If any triggers are missing, drop all and recreate
    if (!triggers || triggers.length < 3) {
      console.log('Triggers missing or incomplete, creating them...');

      // Drop existing triggers if any
      await db.run(`DROP TRIGGER IF EXISTS update_series_stats_insert`);
      await db.run(`DROP TRIGGER IF EXISTS update_series_stats_update`);
      await db.run(`DROP TRIGGER IF EXISTS update_series_stats_delete`);

      // Create triggers
      await db.run(`
        CREATE TRIGGER update_series_stats_insert
        AFTER INSERT ON episodes
        BEGIN
          UPDATE series SET
            episode_count = (SELECT COUNT(*) FROM episodes WHERE series_id = NEW.series_id),
            total_duration = (SELECT COALESCE(SUM(duration), 0) FROM episodes WHERE series_id = NEW.series_id),
            first_recorded = COALESCE(
              (SELECT MIN(start_time) FROM episodes WHERE series_id = NEW.series_id),
              first_recorded
            ),
            last_recorded = COALESCE(
              (SELECT MAX(start_time) FROM episodes WHERE series_id = NEW.series_id),
              last_recorded
            ),
            updated_at = CURRENT_TIMESTAMP
          WHERE id = NEW.series_id;
        END
      `);

      await db.run(`
        CREATE TRIGGER update_series_stats_update
        AFTER UPDATE ON episodes
        BEGIN
          UPDATE series SET
            episode_count = (SELECT COUNT(*) FROM episodes WHERE series_id = NEW.series_id),
            total_duration = (SELECT COALESCE(SUM(duration), 0) FROM episodes WHERE series_id = NEW.series_id),
            first_recorded = COALESCE(
              (SELECT MIN(start_time) FROM episodes WHERE series_id = NEW.series_id),
              first_recorded
            ),
            last_recorded = COALESCE(
              (SELECT MAX(start_time) FROM episodes WHERE series_id = NEW.series_id),
              last_recorded
            ),
            updated_at = CURRENT_TIMESTAMP
          WHERE id = NEW.series_id;
        END
      `);

      await db.run(`
        CREATE TRIGGER update_series_stats_delete
        AFTER DELETE ON episodes
        BEGIN
          UPDATE series SET
            episode_count = (SELECT COUNT(*) FROM episodes WHERE series_id = OLD.series_id),
            total_duration = (SELECT COALESCE(SUM(duration), 0) FROM episodes WHERE series_id = OLD.series_id),
            first_recorded = (SELECT MIN(start_time) FROM episodes WHERE series_id = OLD.series_id),
            last_recorded = (SELECT MAX(start_time) FROM episodes WHERE series_id = OLD.series_id),
            updated_at = CURRENT_TIMESTAMP
          WHERE id = OLD.series_id;
        END
      `);

      console.log('Triggers created successfully');
    }
  }

  async recalculateSeriesStats() {
    // Recalculate statistics for all series
    // Useful for fixing existing databases or after adding triggers
    await db.run(`
      UPDATE series SET
        episode_count = (
          SELECT COUNT(*) FROM episodes WHERE series_id = series.id
        ),
        total_duration = (
          SELECT COALESCE(SUM(duration), 0) FROM episodes WHERE series_id = series.id
        ),
        first_recorded = (
          SELECT MIN(start_time) FROM episodes WHERE series_id = series.id
        ),
        last_recorded = (
          SELECT MAX(start_time) FROM episodes WHERE series_id = series.id
        ),
        updated_at = CURRENT_TIMESTAMP
    `);

    console.log('Series statistics recalculated successfully');
  }

  async close() {
    if (this.isOpen) {
      await db.close();
      this.isOpen = false;
    }
  }
}

module.exports = HDHomeRunDatabase;
