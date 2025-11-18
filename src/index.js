const HDHomeRunDiscovery = require('./discovery');
const HDHomeRunDVR = require('./dvr');
const HDHomeRunDatabase = require('./database');

async function main() {
  const verbose = process.argv.includes('--verbose') || process.argv.includes('-v');
  
  console.log('Initializing database...');
  const database = new HDHomeRunDatabase();
  await database.initialize();
  
  console.log('Discovering HDHomeRun devices on the network...\n');
  
  try {
    const discovery = new HDHomeRunDiscovery(verbose);
    const devices = await discovery.discoverDevices();
    
    if (devices.length === 0) {
      console.log('No HDHomeRun devices found on the network.');
      console.log('Make sure your HDHomeRun device is powered on and connected to the same network.\n');
      return;
    }

    console.log(`Found ${devices.length} HDHomeRun device(s):\n`);
    
    for (let i = 0; i < devices.length; i++) {
      const device = devices[i];
      console.log(`Device ${i + 1}:`);
      console.log(`   Name: ${device.FriendlyName || 'Unknown'}`);
      console.log(`   Model: ${device.ModelNumber || 'Unknown'}`);
      console.log(`   Device ID: ${device.DeviceID || 'Unknown'}`);
      console.log(`   IP Address: ${device.ip}`);
      console.log(`   Firmware: ${device.FirmwareName || 'Unknown'}`);
      console.log(`   Tuners: ${device.TunerCount || 'Unknown'}`);
      console.log('');
    }

    // Check for DVR storage devices
    console.log('Checking for DVR storage capabilities...\n');
    const storageDevices = await discovery.discoverStorageDevices();
    
    if (storageDevices.length === 0) {
      console.log('No HDHomeRun DVR storage devices found.');
      console.log('DVR functionality requires HDHomeRun RECORD or SERVIO devices.\n');
      return;
    }

    console.log(`Found ${storageDevices.length} DVR storage device(s):\n`);

    // List DVR content for each storage device
    for (let i = 0; i < storageDevices.length; i++) {
      const device = storageDevices[i];
      console.log(`DVR Device: ${device.FriendlyName || device.ip}`);
      
      const dvr = new HDHomeRunDVR(device);
      
      // Get storage info
      const storageInfo = await dvr.getStorageInfo();
      if (storageInfo.FreeSpace !== undefined) {
        const totalSpace = storageInfo.TotalSpace || 0;
        const freeSpace = storageInfo.FreeSpace || 0;
        const usedSpace = totalSpace - freeSpace;
        
        console.log(`   Storage: ${dvr.formatFileSize(usedSpace)} used / ${dvr.formatFileSize(totalSpace)} total`);
        console.log(`   Free Space: ${dvr.formatFileSize(freeSpace)}`);
        
        // Update device with storage info
        device.TotalSpace = totalSpace;
        device.FreeSpace = freeSpace;
      }
      console.log('');

      // Get recorded shows
      console.log('Recorded Shows and Episodes:\n');
      const shows = await dvr.getRecordedShows();
      
      // Sync device and content data to database
      console.log(`Syncing ${shows.length} series to database...`);
      await database.syncDeviceData(device, shows);
      
      if (shows.length === 0) {
        console.log('   No recorded shows found.\n');
        continue;
      }

      shows.forEach((show, showIndex) => {
        console.log(`   ${show.title} (${show.episodes.length} episode${show.episodes.length !== 1 ? 's' : ''})`);
        if (show.category) {
          console.log(`      Category: ${show.category}`);
        }
        
        show.episodes.forEach((episode, episodeIndex) => {
          const duration = dvr.formatDuration(episode.startTime, episode.endTime);
          const date = episode.startTime.toLocaleDateString();
          const time = episode.startTime.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
          
          let episodeTitle = episode.title || 'Untitled Episode';
          if (episode.episodeNumber) {
            episodeTitle = `${episode.episodeNumber}: ${episodeTitle}`;
          }
          
          console.log(`      ${episodeIndex + 1}. ${episodeTitle}`);
          console.log(`         ${date} at ${time} (${duration})`);
          console.log(`         ${episode.channelName || 'Unknown'} (${episode.channelNumber || 'N/A'})`);
          
          if (episode.originalAirdate && episode.originalAirdate.getTime() !== episode.startTime.getTime()) {
            const airDate = episode.originalAirdate.toLocaleDateString();
            console.log(`         Originally aired: ${airDate}`);
          }
          
          if (episode.filename) {
            console.log(`         File: ${episode.filename}`);
          }
          
          if (episode.playURL) {
            console.log(`         Play URL: ${episode.playURL}`);
          }
          
          if (episode.resume && episode.resume !== 4294967295) {
            const resumeTime = Math.floor(episode.resume / 60);
            console.log(`         Resume at: ${resumeTime} minutes`);
          }
          
          if (episode.synopsis) {
            const synopsis = episode.synopsis.length > 120 
              ? episode.synopsis.substring(0, 120) + '...' 
              : episode.synopsis;
            console.log(`         Synopsis: ${synopsis}`);
          }
          console.log('');
        });
      });

      // Get recording rules
      console.log('Recording Rules:\n');
      const rules = await dvr.getRecordingRules();
      
      if (rules.length === 0) {
        console.log('   No recording rules configured.\n');
      } else {
        rules.forEach((rule, index) => {
          console.log(`   ${index + 1}. ${rule.Title || 'Untitled Rule'}`);
          if (rule.ChannelOnly) {
            console.log(`      Channel: ${rule.ChannelOnly}`);
          }
          if (rule.SeriesID) {
            console.log(`      Series ID: ${rule.SeriesID}`);
          }
          console.log('');
        });
      }
    }

    // Display database statistics
    console.log('\nDatabase Summary:');
    const stats = await database.getDeviceStats();
    console.log(`   Devices: ${stats.devices}`);
    console.log(`   Series: ${stats.series}`);
    console.log(`   Episodes: ${stats.episodes}`);
    if (stats.totalDurationHours > 0) {
      console.log(`   Total Content: ${stats.totalDurationHours} hours`);
    }
    console.log('');

    await database.close();

  } catch (error) {
    console.error('Error:', error.message);
    console.error('\nTroubleshooting tips:');
    console.error('- Ensure HDHomeRun device is powered on and connected');
    console.error('- Check that your computer is on the same network');
    console.error('- Verify firewall settings allow UDP broadcast on port 65001');
    console.error('- Try running as administrator if on Windows\n');
    
    // Ensure database is closed on error
    try {
      if (database) await database.close();
    } catch (closeError) {
      // Ignore close errors
    }
  }
}

if (require.main === module) {
  main();
}

module.exports = { HDHomeRunDiscovery, HDHomeRunDVR };