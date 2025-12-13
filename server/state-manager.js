const fs = require('fs');
const path = require('path');

class StateManager {
  constructor() {
    this.dataDir = path.join(__dirname, '../data');
    this.stateFile = path.join(this.dataDir, 'server-state.json');
    this.logsFile = path.join(this.dataDir, 'logs.json');
    this.screenshotFile = path.join(this.dataDir, 'last-screenshot.json');
    
    this.ensureDataDir();
    
    this.state = this.loadState();
    this.logs = this.loadLogs();
    const screenshots = this.loadScreenshot();
    this.lastScreenshot = screenshots.automation || null;
    this.faucetScreenshot = screenshots.faucet || null;
    
    this.saveInterval = setInterval(() => this.saveAll(), 30000);
  }

  ensureDataDir() {
    if (!fs.existsSync(this.dataDir)) {
      fs.mkdirSync(this.dataDir, { recursive: true });
    }
  }

  loadState() {
    try {
      if (fs.existsSync(this.stateFile)) {
        const data = fs.readFileSync(this.stateFile, 'utf8');
        return JSON.parse(data);
      }
    } catch (err) {
      console.error('Error loading state:', err.message);
    }
    return {
      faucetConfig: {
        connectionType: 'direct',
        proxyUrl: null,
        bankWalletName: null,
        autoRestart: true
      },
      gpuWorkerUrl: null,
      automationSettings: {}
    };
  }

  loadLogs() {
    try {
      if (fs.existsSync(this.logsFile)) {
        const data = fs.readFileSync(this.logsFile, 'utf8');
        const logs = JSON.parse(data);
        return {
          automation: logs.automation || [],
          faucet: logs.faucet || [],
          nano: logs.nano || []
        };
      }
    } catch (err) {
      console.error('Error loading logs:', err.message);
    }
    return {
      automation: [],
      faucet: [],
      nano: []
    };
  }

  loadScreenshot() {
    try {
      if (fs.existsSync(this.screenshotFile)) {
        const data = fs.readFileSync(this.screenshotFile, 'utf8');
        return JSON.parse(data);
      }
    } catch (err) {
      console.error('Error loading screenshot:', err.message);
    }
    return { automation: null, faucet: null };
  }

  saveState() {
    try {
      fs.writeFileSync(this.stateFile, JSON.stringify(this.state, null, 2));
    } catch (err) {
      console.error('Error saving state:', err.message);
    }
  }

  saveLogs() {
    try {
      const logsToSave = {
        automation: this.logs.automation.slice(0, 500),
        faucet: this.logs.faucet.slice(0, 500),
        nano: this.logs.nano.slice(0, 200)
      };
      fs.writeFileSync(this.logsFile, JSON.stringify(logsToSave, null, 2));
    } catch (err) {
      console.error('Error saving logs:', err.message);
    }
  }

  saveScreenshot() {
    try {
      const screenshots = {
        automation: this.lastScreenshot,
        faucet: this.faucetScreenshot
      };
      fs.writeFileSync(this.screenshotFile, JSON.stringify(screenshots));
    } catch (err) {
      console.error('Error saving screenshot:', err.message);
    }
  }

  saveAll() {
    this.saveState();
    this.saveLogs();
    this.saveScreenshot();
  }

  addAutomationLog(entry) {
    this.logs.automation.unshift(entry);
    if (this.logs.automation.length > 1000) {
      this.logs.automation.pop();
    }
  }

  addFaucetLog(entry) {
    this.logs.faucet.unshift(entry);
    if (this.logs.faucet.length > 1000) {
      this.logs.faucet.pop();
    }
  }

  addNanoLog(entry) {
    this.logs.nano.unshift(entry);
    if (this.logs.nano.length > 500) {
      this.logs.nano.pop();
    }
  }

  getAutomationLogs(limit = 100) {
    return this.logs.automation.slice(0, limit);
  }

  getFaucetLogs(limit = 100) {
    return this.logs.faucet.slice(0, limit);
  }

  getNanoLogs(limit = 100) {
    return this.logs.nano.slice(0, limit);
  }

  setLastScreenshot(image, label, type = 'automation') {
    this.lastScreenshot = {
      image,
      label,
      type,
      timestamp: new Date().toISOString()
    };
  }

  setFaucetScreenshot(image, label) {
    this.faucetScreenshot = {
      image,
      label,
      timestamp: new Date().toISOString()
    };
  }

  getLastScreenshot() {
    return this.lastScreenshot;
  }

  getFaucetScreenshot() {
    return this.faucetScreenshot;
  }

  setFaucetConfig(config) {
    this.state.faucetConfig = { ...this.state.faucetConfig, ...config };
    this.saveState();
  }

  getFaucetConfig() {
    return this.state.faucetConfig;
  }

  setGpuWorkerUrl(url) {
    this.state.gpuWorkerUrl = url;
    this.saveState();
  }

  getGpuWorkerUrl() {
    return this.state.gpuWorkerUrl;
  }

  clearLogs(type) {
    if (type === 'automation') {
      this.logs.automation = [];
    } else if (type === 'faucet') {
      this.logs.faucet = [];
    } else if (type === 'nano') {
      this.logs.nano = [];
    } else {
      this.logs = { automation: [], faucet: [], nano: [] };
    }
    this.saveLogs();
  }

  getFullState() {
    return {
      state: this.state,
      logs: this.logs,
      lastScreenshot: this.lastScreenshot,
      faucetScreenshot: this.faucetScreenshot
    };
  }

  shutdown() {
    clearInterval(this.saveInterval);
    this.saveAll();
  }
}

const stateManager = new StateManager();

process.on('SIGINT', () => {
  stateManager.shutdown();
  process.exit(0);
});

process.on('SIGTERM', () => {
  stateManager.shutdown();
  process.exit(0);
});

module.exports = { stateManager };
