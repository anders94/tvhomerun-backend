-- HDHomeRun DVR Content Database Schema
-- This schema stores HDHomeRun series and episode data for offline access and management

-- Enable foreign key constraints
PRAGMA foreign_keys = ON;

-- Devices table to track HDHomeRun devices
CREATE TABLE devices (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    device_id TEXT NOT NULL UNIQUE,           -- HDHomeRun Device ID (e.g., "10AA5474")
    friendly_name TEXT,                       -- User-friendly device name
    model_number TEXT,                        -- Device model (e.g., "HDFX-4K")
    firmware_name TEXT,                       -- Firmware identifier
    firmware_version TEXT,                    -- Firmware version string
    ip_address TEXT,                          -- Current IP address
    base_url TEXT,                            -- Base URL for API access
    storage_id TEXT,                          -- Storage identifier for DVR
    storage_url TEXT,                         -- URL for recorded files API
    total_space INTEGER,                      -- Total storage in bytes
    free_space INTEGER,                       -- Free storage in bytes
    device_auth TEXT,                         -- Device authentication token
    tuner_count INTEGER,                      -- Number of tuners
    last_seen DATETIME DEFAULT CURRENT_TIMESTAMP,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Index for fast device lookups
CREATE INDEX idx_devices_device_id ON devices(device_id);
CREATE INDEX idx_devices_ip ON devices(ip_address);

-- Series table for recorded shows/programs
CREATE TABLE series (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    device_id INTEGER NOT NULL,              -- Foreign key to devices table
    series_id TEXT NOT NULL,                 -- HDHomeRun Series ID (e.g., "C28817988ENAQAO")
    title TEXT NOT NULL,                     -- Series title
    category TEXT,                           -- Category (sport, series, movie, news, etc.)
    image_url TEXT,                          -- URL to series artwork/poster
    episodes_url TEXT,                       -- API endpoint to get episodes
    start_time INTEGER,                      -- Unix timestamp of series start
    update_id INTEGER,                       -- HDHomeRun update counter
    episode_count INTEGER DEFAULT 0,         -- Cached count of episodes
    total_duration INTEGER DEFAULT 0,        -- Total duration of all episodes in seconds
    first_recorded DATETIME,                 -- Timestamp of first episode recorded
    last_recorded DATETIME,                  -- Timestamp of most recent episode
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    
    FOREIGN KEY (device_id) REFERENCES devices(id) ON DELETE CASCADE
);

-- Indexes for series lookups
CREATE UNIQUE INDEX idx_series_device_series ON series(device_id, series_id);
CREATE INDEX idx_series_title ON series(title);
CREATE INDEX idx_series_category ON series(category);
CREATE INDEX idx_series_updated ON series(updated_at);

-- Episodes table for individual recordings
CREATE TABLE episodes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    series_id INTEGER NOT NULL,              -- Foreign key to series table
    program_id TEXT,                         -- Guide program ID (e.g., "EP054158040004")
    title TEXT NOT NULL,                     -- Series title
    episode_title TEXT,                      -- Specific episode title
    episode_number TEXT,                     -- Episode number (e.g., "S05E07")
    season_number INTEGER,                   -- Extracted season number
    episode_num INTEGER,                     -- Extracted episode number within season
    synopsis TEXT,                           -- Episode description/synopsis
    category TEXT,                           -- Episode category
    
    -- Channel information
    channel_name TEXT,                       -- Channel name (e.g., "WGBHDT")
    channel_number TEXT,                     -- Channel number (e.g., "2.1")
    channel_image_url TEXT,                  -- Channel logo URL
    
    -- Timing information (all Unix timestamps)
    start_time INTEGER NOT NULL,            -- Broadcast start time
    end_time INTEGER NOT NULL,              -- Broadcast end time
    duration INTEGER GENERATED ALWAYS AS (end_time - start_time) STORED,
    original_airdate INTEGER,               -- Original air date
    record_start_time INTEGER,              -- Actual recording start
    record_end_time INTEGER,                -- Actual recording end
    first_airing INTEGER DEFAULT 0,         -- 1 if first airing, 0 if repeat
    
    -- File information
    filename TEXT,                           -- Recorded file name
    file_size INTEGER,                       -- File size in bytes (if available)
    play_url TEXT,                           -- Direct streaming URL
    cmd_url TEXT,                            -- Command/control URL
    
    -- Playback information
    resume_position INTEGER DEFAULT 0,      -- Resume position in seconds
    watched BOOLEAN DEFAULT FALSE,          -- Has been fully watched
    record_success INTEGER DEFAULT 1,       -- Recording successful (1) or failed (0)
    
    -- Metadata
    image_url TEXT,                          -- Episode artwork URL
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    
    FOREIGN KEY (series_id) REFERENCES series(id) ON DELETE CASCADE
);

-- Indexes for episode lookups and sorting
CREATE INDEX idx_episodes_series ON episodes(series_id);
CREATE INDEX idx_episodes_program_id ON episodes(program_id);
CREATE INDEX idx_episodes_start_time ON episodes(start_time);
CREATE INDEX idx_episodes_channel ON episodes(channel_name, channel_number);
CREATE INDEX idx_episodes_watched ON episodes(watched);
CREATE INDEX idx_episodes_category ON episodes(category);
CREATE INDEX idx_episodes_season_episode ON episodes(season_number, episode_num);

-- View for complete episode information with series details
CREATE VIEW episode_details AS
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
    e.original_airdate,
    e.filename,
    e.play_url,
    e.resume_position,
    e.watched,
    e.created_at as episode_created,
    s.series_id,
    s.title as series_title,
    s.image_url as series_image,
    d.device_id,
    d.friendly_name as device_name,
    d.ip_address
FROM episodes e
JOIN series s ON e.series_id = s.id
JOIN devices d ON s.device_id = d.id;

-- View for series summary with statistics
CREATE VIEW series_summary AS
SELECT 
    s.id,
    s.series_id,
    s.title,
    s.category,
    s.image_url,
    COUNT(e.id) as episode_count,
    SUM(e.duration) as total_duration,
    MIN(e.start_time) as first_episode_date,
    MAX(e.start_time) as last_episode_date,
    SUM(CASE WHEN e.watched THEN 1 ELSE 0 END) as watched_count,
    SUM(CASE WHEN e.resume_position > 0 AND NOT e.watched THEN 1 ELSE 0 END) as in_progress_count,
    d.device_id,
    d.friendly_name as device_name,
    s.created_at
FROM series s
LEFT JOIN episodes e ON s.id = e.series_id
JOIN devices d ON s.device_id = d.id
GROUP BY s.id;

-- Triggers to maintain series statistics
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
END;

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
END;

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
END;

-- Utility functions for common queries

-- Function to extract season number from episode number string
-- Note: SQLite doesn't have user-defined functions, but this shows the logic
-- Implementation would need to be done in application code:
-- 
-- function extractSeasonNumber(episodeNumber) {
--   if (!episodeNumber) return null;
--   const match = episodeNumber.match(/S(\d+)E(\d+)/i);
--   return match ? parseInt(match[1]) : null;
-- }
-- 
-- function extractEpisodeNumber(episodeNumber) {
--   if (!episodeNumber) return null;
--   const match = episodeNumber.match(/S(\d+)E(\d+)/i);
--   return match ? parseInt(match[2]) : null;
-- }

-- Example queries for common operations:

-- Get all unwatched episodes for a series:
-- SELECT * FROM episode_details WHERE series_title = 'All Creatures Great and Small on Masterpiece' AND NOT watched ORDER BY start_time;

-- Get series with most episodes:
-- SELECT * FROM series_summary ORDER BY episode_count DESC LIMIT 10;

-- Get episodes to resume watching:
-- SELECT * FROM episode_details WHERE resume_position > 0 AND NOT watched ORDER BY updated_at DESC;

-- Get recently added episodes:
-- SELECT * FROM episode_details ORDER BY episode_created DESC LIMIT 20;

-- Get storage usage by series:
-- SELECT series_title, COUNT(*) as episodes, SUM(duration)/3600 as hours, device_name
-- FROM episode_details GROUP BY series_title ORDER BY hours DESC;

-- ============================================================================
-- Program Guide and Recording Rules Tables
-- ============================================================================

-- Channels table for caching guide channel information
CREATE TABLE IF NOT EXISTS guide_channels (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    guide_number TEXT NOT NULL,              -- User-facing channel number (e.g., "2.1")
    guide_name TEXT NOT NULL,                -- Channel call letters (e.g., "WGBHDT")
    affiliate TEXT,                          -- Network affiliation (PBS, CBS, NBC, etc.)
    image_url TEXT,                          -- Channel logo/branding image
    channel_id TEXT,                         -- Internal channel ID (e.g., "US28055.hdhomerun.com")
    last_updated DATETIME DEFAULT CURRENT_TIMESTAMP,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,

    UNIQUE(guide_number)
);

CREATE INDEX IF NOT EXISTS idx_guide_channels_number ON guide_channels(guide_number);
CREATE INDEX IF NOT EXISTS idx_guide_channels_name ON guide_channels(guide_name);
CREATE INDEX IF NOT EXISTS idx_guide_channels_updated ON guide_channels(last_updated);

-- Programs table for caching program guide data
CREATE TABLE IF NOT EXISTS guide_programs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    channel_id INTEGER NOT NULL,             -- Foreign key to guide_channels
    series_id TEXT NOT NULL,                 -- Series identifier (critical for recording rules)
    title TEXT NOT NULL,                     -- Program title
    episode_number TEXT,                     -- Season/episode (e.g., "S48E15")
    episode_title TEXT,                      -- Episode name
    synopsis TEXT,                           -- Program description
    start_time INTEGER NOT NULL,             -- Unix timestamp when program starts
    end_time INTEGER NOT NULL,               -- Unix timestamp when program ends
    duration INTEGER GENERATED ALWAYS AS (end_time - start_time) STORED,
    original_airdate INTEGER,                -- Unix timestamp of first broadcast
    image_url TEXT,                          -- Series artwork
    filters TEXT,                            -- JSON array of category tags
    last_updated DATETIME DEFAULT CURRENT_TIMESTAMP,

    FOREIGN KEY (channel_id) REFERENCES guide_channels(id) ON DELETE CASCADE,
    UNIQUE(channel_id, series_id, start_time)
);

CREATE INDEX IF NOT EXISTS idx_guide_programs_channel ON guide_programs(channel_id);
CREATE INDEX IF NOT EXISTS idx_guide_programs_series ON guide_programs(series_id);
CREATE INDEX IF NOT EXISTS idx_guide_programs_time ON guide_programs(start_time, end_time);
CREATE INDEX IF NOT EXISTS idx_guide_programs_title ON guide_programs(title);

-- Recording Rules table for caching cloud recording rules
CREATE TABLE IF NOT EXISTS recording_rules (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    recording_rule_id TEXT NOT NULL UNIQUE,  -- ID from cloud API
    series_id TEXT NOT NULL,                 -- Series identifier
    title TEXT,                              -- Program title (populated by cloud)
    synopsis TEXT,                           -- Program description
    image_url TEXT,                          -- Series artwork
    channel_only TEXT,                       -- Pipe-separated channel numbers
    team_only TEXT,                          -- Pipe-separated team names (sports)
    recent_only BOOLEAN DEFAULT 0,           -- Only record new episodes
    after_original_airdate_only INTEGER,     -- Unix timestamp threshold
    date_time_only INTEGER,                  -- Unix timestamp for one-time recording
    priority INTEGER,                        -- Rule priority (1 = highest)
    start_padding INTEGER DEFAULT 30,        -- Seconds to start early
    end_padding INTEGER DEFAULT 30,          -- Seconds to continue after end
    last_synced DATETIME DEFAULT CURRENT_TIMESTAMP,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_recording_rules_series ON recording_rules(series_id);
CREATE INDEX IF NOT EXISTS idx_recording_rules_priority ON recording_rules(priority);
CREATE INDEX IF NOT EXISTS idx_recording_rules_updated ON recording_rules(updated_at);

-- View for current/upcoming programs (next 24 hours)
CREATE VIEW IF NOT EXISTS current_guide AS
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
    p.image_url as program_image,
    p.filters,
    CASE
        WHEN p.start_time <= strftime('%s', 'now') AND p.end_time > strftime('%s', 'now') THEN 1
        ELSE 0
    END as is_current
FROM guide_programs p
JOIN guide_channels c ON p.channel_id = c.id
WHERE p.start_time < strftime('%s', 'now', '+24 hours')
ORDER BY c.guide_number, p.start_time;

-- View for recording rules with series information
CREATE VIEW IF NOT EXISTS recording_rules_detail AS
SELECT
    rr.recording_rule_id,
    rr.series_id,
    rr.title,
    rr.synopsis,
    rr.image_url,
    rr.channel_only,
    rr.team_only,
    rr.recent_only,
    rr.after_original_airdate_only,
    rr.date_time_only,
    rr.priority,
    rr.start_padding,
    rr.end_padding,
    rr.last_synced,
    COUNT(DISTINCT s.id) as local_episodes_count,
    MAX(e.start_time) as last_recording_time
FROM recording_rules rr
LEFT JOIN series s ON s.series_id = rr.series_id
LEFT JOIN episodes e ON e.series_id = s.id
GROUP BY rr.recording_rule_id;