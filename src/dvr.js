const axios = require('axios');

class HDHomeRunDVR {
  constructor(device) {
    this.device = device;
    this.baseUrl = `http://${device.ip}`;
  }

  async getRecordedShows() {
    try {
      // First get the series list
      const response = await axios.get(`${this.baseUrl}/recorded_files.json`, {
        timeout: 10000
      });
      
      if (!response.data || !Array.isArray(response.data)) {
        return [];
      }

      const shows = [];
      
      // For each series, get the episodes
      for (const series of response.data) {
        try {
          const episodesResponse = await axios.get(series.EpisodesURL, {
            timeout: 5000
          });
          
          if (episodesResponse.data && Array.isArray(episodesResponse.data)) {
            const episodes = episodesResponse.data.map(episode => ({
              title: episode.EpisodeTitle || episode.Title || 'Untitled Episode',
              episodeNumber: episode.EpisodeNumber || '',
              filename: episode.Filename,
              startTime: new Date(episode.StartTime * 1000),
              endTime: new Date(episode.EndTime * 1000),
              channelName: episode.ChannelName,
              channelNumber: episode.ChannelNumber,
              channelImageURL: episode.ChannelImageURL,
              synopsis: episode.Synopsis || '',
              category: episode.Category || series.Category || '',
              playURL: episode.PlayURL,
              cmdURL: episode.CmdURL,
              originalAirdate: episode.OriginalAirdate ? new Date(episode.OriginalAirdate * 1000) : null,
              programID: episode.ProgramID,
              resume: episode.Resume,
              recordStartTime: episode.RecordStartTime,
              recordEndTime: episode.RecordEndTime,
              firstAiring: episode.FirstAiring,
              recordSuccess: episode.RecordSuccess,
              imageURL: episode.ImageURL
            }));
            
            // Sort episodes by start time
            episodes.sort((a, b) => a.startTime - b.startTime);
            
            shows.push({
              title: series.Title,
              seriesID: series.SeriesID,
              category: series.Category,
              imageURL: series.ImageURL,
              episodesURL: series.EpisodesURL,
              startTime: series.StartTime,
              updateID: series.UpdateID,
              episodes: episodes
            });
          }
        } catch (episodeError) {
          console.error(`Failed to get episodes for ${series.Title}:`, episodeError.message);
          // Still add the series even if we can't get episodes
          shows.push({
            title: series.Title,
            seriesID: series.SeriesID,
            category: series.Category,
            imageURL: series.ImageURL,
            episodesURL: series.EpisodesURL,
            startTime: series.StartTime,
            updateID: series.UpdateID,
            episodes: []
          });
        }
      }

      return shows;
    } catch (error) {
      console.error(`Failed to get recorded shows from ${this.device.ip}:`, error.message);
      return [];
    }
  }

  async getRecordingRules() {
    try {
      const response = await axios.get(`${this.baseUrl}/api/recording_rules`, {
        timeout: 5000
      });
      
      return response.data || [];
    } catch (error) {
      console.error(`Failed to get recording rules from ${this.device.ip}:`, error.message);
      return [];
    }
  }

  async getEpisodes() {
    try {
      const response = await axios.get(`${this.baseUrl}/api/episodes`, {
        timeout: 10000
      });
      
      return response.data || [];
    } catch (error) {
      console.error(`Failed to get episodes from ${this.device.ip}:`, error.message);
      return [];
    }
  }

  async getFileSize(filename) {
    // Try to get file size from filesystem info endpoint if available
    try {
      const response = await axios.get(`${this.baseUrl}/recorded/info?file=${encodeURIComponent(filename)}`, {
        timeout: 3000
      });
      
      if (response.data && response.data.FileSize) {
        return response.data.FileSize;
      }
    } catch (error) {
      // File info endpoint not available
    }
    
    return null;
  }

  async getStorageInfo() {
    // Try multiple endpoints for storage information
    const storageEndpoints = [
      '/api/storage',
      '/storage.json',
      '/status.json'
    ];

    for (const endpoint of storageEndpoints) {
      try {
        const response = await axios.get(`${this.baseUrl}${endpoint}`, {
          timeout: 5000
        });
        
        if (response.data) {
          // Check for storage-related fields
          if (response.data.FreeSpace !== undefined || 
              response.data.UsedSpace !== undefined ||
              response.data.TotalSpace !== undefined) {
            return response.data;
          }
        }
      } catch (error) {
        // Try next endpoint
        continue;
      }
    }

    // If no storage API available, try to get basic info from device
    try {
      const response = await axios.get(`${this.baseUrl}/discover.json`, {
        timeout: 5000
      });
      
      return {
        StorageURL: response.data?.StorageURL,
        StorageID: response.data?.StorageID
      };
    } catch (error) {
      console.error(`Failed to get storage info from ${this.device.ip}:`, error.message);
      return {};
    }
  }

  formatFileSize(bytes) {
    if (bytes === 0) return '0 Bytes';
    
    const k = 1024;
    const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
  }

  formatDuration(startTime, endTime) {
    const durationMs = endTime - startTime;
    const minutes = Math.floor(durationMs / (1000 * 60));
    const hours = Math.floor(minutes / 60);
    const remainingMinutes = minutes % 60;
    
    if (hours > 0) {
      return `${hours}h ${remainingMinutes}m`;
    } else {
      return `${remainingMinutes}m`;
    }
  }
}

module.exports = HDHomeRunDVR;