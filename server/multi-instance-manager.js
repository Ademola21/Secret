const { FaucetSentry } = require('./faucet-sentry');
const { v4: uuidv4 } = require('uuid');

class MultiInstanceManager {
  constructor(io, nanoWallet) {
    this.io = io;
    this.nanoWallet = nanoWallet;
    this.instances = new Map();
    this.maxInstances = 10;
    this.activeCount = 0;
    
    this.torPorts = [9050, 9052, 9054, 9056, 9058, 9060, 9062, 9064, 9066, 9068];
    this.controlPorts = [9051, 9053, 9055, 9057, 9059, 9061, 9063, 9065, 9067, 9069];
    
    this.aggregatedStats = {
      totalClaims: 0,
      totalRewards: '0',
      startTime: null
    };
  }

  async checkTorPort(port) {
    const net = require('net');
    return new Promise((resolve) => {
      const socket = new net.Socket();
      socket.setTimeout(2000);
      socket.on('connect', () => {
        socket.destroy();
        resolve(true);
      });
      socket.on('timeout', () => {
        socket.destroy();
        resolve(false);
      });
      socket.on('error', () => {
        resolve(false);
      });
      socket.connect(port, '127.0.0.1');
    });
  }

  async startInstances(count, config) {
    if (count < 1 || count > this.maxInstances) {
      return { success: false, error: `Count must be between 1 and ${this.maxInstances}` };
    }

    if (this.activeCount > 0) {
      return { success: false, error: 'Multi-instance session already running. Stop first.' };
    }

    if (!config.bankWalletName) {
      return { success: false, error: 'No bank wallet configured' };
    }

    if (config.connectionType === 'tor') {
      const availablePorts = [];
      for (let i = 0; i < count; i++) {
        const portAvailable = await this.checkTorPort(this.torPorts[i]);
        if (portAvailable) {
          availablePorts.push(this.torPorts[i]);
        }
      }
      if (availablePorts.length < count) {
        return { 
          success: false, 
          error: `Only ${availablePorts.length} Tor ports available. Need ${count}. Start more Tor instances or reduce count.` 
        };
      }
    }

    this.aggregatedStats = {
      totalClaims: 0,
      totalRewards: '0',
      startTime: new Date().toISOString()
    };

    const startedInstances = [];
    const staggerDelay = 3000;

    this.log('info', `Starting ${count} parallel claim instances...`);

    for (let i = 0; i < count; i++) {
      const instanceId = `instance_${i + 1}`;
      
      const instance = new FaucetSentry(this.io, this.nanoWallet);
      
      instance.torSocksPort = this.torPorts[i];
      instance.torControlPort = this.controlPorts[i];
      instance.instanceId = instanceId;
      instance.instanceIndex = i + 1;
      
      instance.config = { ...config };
      
      // CRITICAL: Enable auto-restart so instances continue after success/failure
      // This makes each instance behave like single-instance mode:
      // - On error: Get new Tor identity, new wallet, retry
      // - On success: Start new claim session immediately
      instance.autoRestartEnabled = true;
      
      const originalLog = instance.log.bind(instance);
      instance.log = (level, message, metadata = {}) => {
        const prefixedMessage = `[Instance ${i + 1}] [Tor:${instance.torSocksPort}] ${message}`;
        originalLog(level, prefixedMessage, { ...metadata, instanceId, torPort: instance.torSocksPort });
        this.emitInstanceUpdate(instanceId, instance);
      };

      instance.on = () => {};
      
      this.instances.set(instanceId, instance);
      startedInstances.push(instanceId);
      
      this.log('info', `Instance ${i + 1} configured: Tor SOCKS=${this.torPorts[i]}, Control=${this.controlPorts[i]}`);
    }

    for (let i = 0; i < startedInstances.length; i++) {
      const instanceId = startedInstances[i];
      const instance = this.instances.get(instanceId);
      
      if (i > 0) {
        await this.delay(staggerDelay);
      }
      
      instance.startClaimSession().catch(err => {
        this.log('error', `Instance ${i + 1} failed: ${err.message}`);
      });
    }

    this.activeCount = count;
    this.emitStatus();

    return { success: true, instances: startedInstances, count };
  }

  async stopAllInstances() {
    if (this.instances.size === 0) {
      return { success: true, message: 'No instances running' };
    }

    this.log('info', 'Stopping all instances...');

    const stopPromises = [];
    for (const [id, instance] of this.instances) {
      instance.autoRestartEnabled = false;
      stopPromises.push(instance.stopSession().catch(e => {
        console.error(`Error stopping ${id}:`, e.message);
      }));
    }

    await Promise.all(stopPromises);
    this.instances.clear();
    this.activeCount = 0;
    this.emitStatus();

    this.log('success', 'All instances stopped');
    return { success: true };
  }

  async stopInstance(instanceId) {
    const instance = this.instances.get(instanceId);
    if (!instance) {
      return { success: false, error: 'Instance not found' };
    }

    instance.autoRestartEnabled = false;
    await instance.stopSession();
    this.instances.delete(instanceId);
    this.activeCount = this.instances.size;
    this.emitStatus();

    return { success: true };
  }

  getStatus() {
    const instanceStatuses = [];
    let aggregatedTotalClaims = 0;
    let aggregatedTotalRewards = 0;

    for (const [id, instance] of this.instances) {
      const stats = instance.sessionStats || {};
      instanceStatuses.push({
        id,
        instanceIndex: instance.instanceIndex,
        status: stats.status || 'unknown',
        torPort: instance.torSocksPort,
        totalClaims: stats.totalClaims || 0,
        totalRewards: stats.totalRewards || '0',
        tempWallet: stats.tempClaimWallet ? 
          `${stats.tempClaimWallet.substring(0, 15)}...` : null,
        isRunning: instance.isRunning,
        isPaused: instance.isPaused
      });

      aggregatedTotalClaims += (stats.totalClaims || 0);
      aggregatedTotalRewards += parseFloat(stats.totalRewards || '0');
    }

    return {
      activeCount: this.activeCount,
      maxInstances: this.maxInstances,
      instances: instanceStatuses,
      aggregated: {
        totalClaims: aggregatedTotalClaims,
        totalRewards: aggregatedTotalRewards.toFixed(6),
        startTime: this.aggregatedStats.startTime
      }
    };
  }

  emitStatus() {
    this.io.emit('multi-instance-status', this.getStatus());
  }

  emitInstanceUpdate(instanceId, instance) {
    const stats = instance.sessionStats || {};
    this.io.emit('multi-instance-update', {
      instanceId,
      instanceIndex: instance.instanceIndex,
      status: stats.status,
      totalClaims: stats.totalClaims || 0,
      totalRewards: stats.totalRewards || '0',
      isRunning: instance.isRunning
    });
  }

  log(level, message) {
    const entry = {
      id: uuidv4(),
      timestamp: new Date().toISOString(),
      level,
      message: `[MultiInstance] ${message}`
    };

    this.io.emit('faucet-log', entry);

    const icon = {
      info: 'i',
      success: '+',
      warning: '!',
      error: 'x'
    }[level] || '.';

    console.log(`${icon} [MultiInstance] ${message}`);
  }

  delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

module.exports = { MultiInstanceManager };
