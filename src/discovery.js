const dgram = require('dgram');
const axios = require('axios');
const os = require('os');

class HDHomeRunDiscovery {
  constructor(verbose = false) {
    this.devices = [];
    this.verbose = verbose;
  }

  log(message) {
    if (this.verbose) {
      console.log(`[DEBUG] ${message}`);
    }
  }

  async discoverDevices() {
    this.log('Starting HDHomeRun device discovery...');
    
    // Try UDP discovery first
    const udpDevices = await this.discoverViaUDP();
    
    // Try HTTP discovery as fallback
    const httpDevices = await this.discoverViaHTTP();
    
    // Combine and deduplicate devices
    const allDevices = new Map();
    
    [...udpDevices, ...httpDevices].forEach(device => {
      const key = device.DeviceID || device.ip;
      if (!allDevices.has(key)) {
        allDevices.set(key, device);
      }
    });
    
    this.devices = Array.from(allDevices.values());
    this.log(`Total devices found: ${this.devices.length}`);
    return this.devices;
  }

  async discoverViaUDP() {
    this.log('Attempting UDP discovery...');
    
    return new Promise((resolve) => {
      const client = dgram.createSocket('udp4');
      
      // Correct HDHomeRun discovery packet format with CRC
      const payload = Buffer.alloc(8);
      payload.writeUInt8(0x01, 0); // HDHOMERUN_TAG_DEVICE_TYPE
      payload.writeUInt8(0x04, 1); // Length: 4 bytes
      payload.writeUInt32BE(0xFFFFFFFF, 2); // HDHOMERUN_DEVICE_TYPE_WILDCARD
      payload.writeUInt8(0x02, 6); // HDHOMERUN_TAG_DEVICE_ID
      payload.writeUInt8(0x04, 7); // Length: 4 bytes
      // Device ID wildcard will be added after
      
      const header = Buffer.alloc(4);
      header.writeUInt16BE(0x0002, 0); // HDHOMERUN_TYPE_DISCOVER_REQ
      header.writeUInt16BE(payload.length + 4, 2); // Payload length + 4 for device ID
      
      const deviceIdWildcard = Buffer.alloc(4);
      deviceIdWildcard.writeUInt32BE(0xFFFFFFFF, 0);
      
      const packetWithoutCrc = Buffer.concat([header, payload, deviceIdWildcard]);
      const crc = this.calculateCRC32(packetWithoutCrc);
      const crcBuffer = Buffer.alloc(4);
      crcBuffer.writeUInt32LE(crc, 0);
      
      const discoveryPacket = Buffer.concat([packetWithoutCrc, crcBuffer]);
      
      this.log(`Discovery packet: ${discoveryPacket.toString('hex')}`);

      const devices = new Map();
      let timeout;

      client.on('message', async (msg, rinfo) => {
        this.log(`Received UDP response from ${rinfo.address}:${rinfo.port}, ${msg.length} bytes`);
        this.log(`Response data: ${msg.toString('hex')}`);
        
        try {
          const deviceInfo = this.parseDiscoveryResponse(msg);
          this.log(`Parsed device info: ${JSON.stringify(deviceInfo)}`);
          
          if (deviceInfo && deviceInfo.deviceId) {
            const deviceKey = `${rinfo.address}-${deviceInfo.deviceId}`;
            
            if (!devices.has(deviceKey)) {
              const fullDeviceInfo = await this.getDeviceDetails(rinfo.address);
              if (fullDeviceInfo) {
                fullDeviceInfo.ip = rinfo.address;
                devices.set(deviceKey, fullDeviceInfo);
                this.log(`Added device: ${fullDeviceInfo.FriendlyName} (${rinfo.address})`);
              }
            }
          }
        } catch (error) {
          this.log(`Error parsing discovery response: ${error.message}`);
        }
      });

      client.on('error', (err) => {
        this.log(`UDP client error: ${err.message}`);
        client.close();
        resolve([]);
      });

      client.bind(() => {
        client.setBroadcast(true);
        this.log('UDP socket bound, sending broadcast...');
        
        client.send(discoveryPacket, 65001, '255.255.255.255', (err) => {
          if (err) {
            this.log(`UDP send error: ${err.message}`);
            client.close();
            resolve([]);
            return;
          }
          
          this.log('Discovery packet sent, waiting for responses...');

          timeout = setTimeout(() => {
            this.log(`UDP discovery timeout, found ${devices.size} devices`);
            client.close();
            resolve(Array.from(devices.values()));
          }, 3000);
        });
      });
    });
  }

  calculateCRC32(data) {
    // Simple CRC32 implementation for HDHomeRun packets
    const crcTable = [];
    for (let i = 0; i < 256; i++) {
      let c = i;
      for (let j = 0; j < 8; j++) {
        c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
      }
      crcTable[i] = c;
    }

    let crc = 0xFFFFFFFF;
    for (let i = 0; i < data.length; i++) {
      crc = crcTable[(crc ^ data[i]) & 0xFF] ^ (crc >>> 8);
    }
    return (crc ^ 0xFFFFFFFF) >>> 0;
  }

  parseDiscoveryResponse(buffer) {
    if (buffer.length < 8) return null;
    
    // Skip header (type + length)
    let offset = 4;
    const deviceInfo = {};

    // Parse until we reach CRC (last 4 bytes)
    while (offset < buffer.length - 4) {
      if (offset >= buffer.length - 1) break;
      
      const tag = buffer.readUInt8(offset);
      const length = buffer.readUInt8(offset + 1);
      offset += 2;

      if (offset + length > buffer.length - 4) break;

      switch (tag) {
        case 0x01: // Device type
          if (length >= 4) {
            deviceInfo.deviceType = buffer.readUInt32BE(offset);
          }
          break;
        case 0x02: // Device ID
          if (length >= 4) {
            deviceInfo.deviceId = buffer.readUInt32BE(offset).toString(16).toUpperCase().padStart(8, '0');
          }
          break;
        case 0x03: // Tuner count
          if (length >= 1) {
            deviceInfo.tunerCount = buffer.readUInt8(offset);
          }
          break;
      }
      offset += length;
    }

    return deviceInfo;
  }

  async discoverViaHTTP() {
    this.log('Attempting HTTP discovery via my.hdhomerun.com...');
    
    try {
      const response = await axios.get('https://my.hdhomerun.com/discover', {
        timeout: 5000
      });
      
      if (response.data && Array.isArray(response.data)) {
        const devices = [];
        for (const deviceData of response.data) {
          if (deviceData.LocalIP && deviceData.BaseURL) {
            try {
              const details = await this.getDeviceDetails(deviceData.LocalIP);
              if (details) {
                details.ip = deviceData.LocalIP;
                devices.push(details);
                this.log(`Found device via HTTP: ${details.FriendlyName} (${deviceData.LocalIP})`);
              }
            } catch (error) {
              this.log(`Failed to get details for ${deviceData.LocalIP}: ${error.message}`);
            }
          }
        }
        return devices;
      }
    } catch (error) {
      this.log(`HTTP discovery failed: ${error.message}`);
    }
    
    // Try scanning common IP ranges as last resort
    return await this.scanLocalNetwork();
  }

  async scanLocalNetwork() {
    this.log('Scanning local network for HDHomeRun devices...');
    
    const networkInterfaces = os.networkInterfaces();
    const promises = [];
    
    for (const interfaceName in networkInterfaces) {
      const interfaces = networkInterfaces[interfaceName];
      for (const iface of interfaces) {
        if (iface.family === 'IPv4' && !iface.internal) {
          const subnet = this.getSubnet(iface.address, iface.netmask);
          promises.push(this.scanSubnet(subnet));
        }
      }
    }
    
    const results = await Promise.all(promises);
    return results.flat();
  }

  getSubnet(ip, netmask) {
    const ipParts = ip.split('.').map(Number);
    const maskParts = netmask.split('.').map(Number);
    
    const networkParts = ipParts.map((part, i) => part & maskParts[i]);
    return networkParts.join('.');
  }

  async scanSubnet(subnet) {
    const devices = [];
    const promises = [];
    
    // Scan first 50 IPs in subnet (common range for most home networks)
    for (let i = 1; i <= 50; i++) {
      const ip = subnet.split('.').slice(0, 3).join('.') + '.' + i;
      promises.push(this.checkDevice(ip));
    }
    
    const results = await Promise.allSettled(promises);
    for (const result of results) {
      if (result.status === 'fulfilled' && result.value) {
        devices.push(result.value);
      }
    }
    
    return devices;
  }

  async checkDevice(ip) {
    try {
      const device = await this.getDeviceDetails(ip);
      if (device && (device.ModelNumber || '').toLowerCase().includes('hdhomerun')) {
        device.ip = ip;
        this.log(`Found device via network scan: ${device.FriendlyName} (${ip})`);
        return device;
      }
    } catch (error) {
      // Device doesn't respond or isn't HDHomeRun
    }
    return null;
  }

  async getDeviceDetails(ip) {
    try {
      const response = await axios.get(`http://${ip}/discover.json`, {
        timeout: 5000
      });
      
      const deviceData = {
        ...response.data,
        ip: ip
      };

      // Log device capabilities for debugging
      if (this.verbose) {
        this.log(`Device details for ${ip}:`);
        this.log(`  FriendlyName: ${deviceData.FriendlyName}`);
        this.log(`  ModelNumber: ${deviceData.ModelNumber}`);
        this.log(`  DeviceID: ${deviceData.DeviceID}`);
        this.log(`  BaseURL: ${deviceData.BaseURL}`);
        this.log(`  LineupURL: ${deviceData.LineupURL}`);
        this.log(`  StorageURL: ${deviceData.StorageURL}`);
        this.log(`  StorageID: ${deviceData.StorageID}`);
      }
      
      return deviceData;
    } catch (error) {
      this.log(`Failed to get device details from ${ip}: ${error.message}`);
      return null;
    }
  }

  async discoverStorageDevices() {
    const storageDevices = [];
    
    for (const device of this.devices) {
      const hasStorage = await this.checkDeviceStorage(device);
      if (hasStorage) {
        storageDevices.push(device);
        this.log(`Device ${device.FriendlyName} has DVR storage capability`);
      }
    }
    
    return storageDevices;
  }

  async checkDeviceStorage(device) {
    // Check multiple indicators of DVR storage capability
    const storageChecks = [
      this.checkRecordedFiles(device),
      this.checkStorageAPI(device),
      this.checkStorageURL(device)
    ];

    const results = await Promise.allSettled(storageChecks);
    
    // Return true if any storage check passes
    return results.some(result => result.status === 'fulfilled' && result.value === true);
  }

  async checkRecordedFiles(device) {
    try {
      const response = await axios.get(`http://${device.ip}/recorded_files.json`, {
        timeout: 3000
      });
      
      // If we get a response (even empty array), device has DVR capability
      this.log(`Device ${device.ip} has recorded_files.json endpoint`);
      return true;
    } catch (error) {
      return false;
    }
  }

  async checkStorageAPI(device) {
    try {
      const response = await axios.get(`http://${device.ip}/api/storage`, {
        timeout: 3000
      });
      
      if (response.data && response.data.FreeSpace !== undefined) {
        this.log(`Device ${device.ip} has storage API with free space info`);
        return true;
      }
    } catch (error) {
      return false;
    }
    return false;
  }

  async checkStorageURL(device) {
    // Check if device info contains StorageURL
    if (device.StorageURL) {
      this.log(`Device ${device.ip} has StorageURL: ${device.StorageURL}`);
      return true;
    }
    return false;
  }
}

module.exports = HDHomeRunDiscovery;