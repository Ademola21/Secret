const { wallet, block, tools } = require('nanocurrency-web');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const { stateManager } = require('./state-manager');

const CONFIG_FILE = path.join(__dirname, '../data/faucet-sentry-config.json');
const FAUCET_URL = 'https://faucet.banxno.com/';
const FAUCET_DONATION_ADDRESS = 'nano_1ncto1yztp7xu98othx6t5qfifo4qag1o6ziuqkkydzu88gqz5wnb5yspke8';
const RPC_URL = 'http://157.230.168.241:7076';
const RPC_FALLBACK_URLS = [
  'http://157.230.168.241:7076'
];
const POW_RPC_URL = 'https://rainstorm.city/api';
const POW_FALLBACK_URLS = [
  'https://rainstorm.city/api',
  'https://node.somenano.com/proxy',
  'https://proxy.nanos.cc/proxy'
];
const MIN_BANK_BALANCE = 0.001;

class FaucetSentry {
  constructor(io, nanoWallet) {
    this.io = io;
    this.nanoWallet = nanoWallet;
    this.config = this.loadConfig();
    this.isRunning = false;
    this.isPaused = false;
    this.currentSession = null;
    this.logs = stateManager.getFaucetLogs(500);
    this.maxLogs = 500;
    this.browser = null;
    this.page = null;
    this.claimWallet = null;
    this.autoRestartEnabled = true;
    this.usedTorIPs = new Set();
    this.usedUserAgents = new Set();
    this.maxIPHistory = 50;
    this.maxRetryAttempts = 10;
    this.sessionStats = {
      status: 'idle',
      tempClaimWallet: null,
      lastDonationSent: null,
      lastRewardReceived: null,
      nextClaimAvailable: null,
      totalClaims: 0,
      totalRewards: '0',
      consecutiveSessions: 0
    };
    
    this.torSocksPort = 9050;
    this.torControlPort = 9051;
    this.instanceId = 'default';
    this.instanceIndex = 0;
  }
  
  async ensurePortAvailable(port) {
    const { exec } = require('child_process');
    return new Promise((resolve) => {
      exec(`lsof -t -i:${port} 2>/dev/null`, (error, stdout) => {
        const pids = stdout.trim().split('\n').filter(p => p && p !== '');
        
        if (pids.length > 0 && port === 5000) {
          this.log('warning', `Port ${port} in use, attempting to free it...`);
          for (const pid of pids) {
            exec(`kill -9 ${pid} 2>/dev/null`);
          }
          setTimeout(() => resolve(true), 1000);
        } else {
          resolve(pids.length === 0);
        }
      });
    });
  }
  
  async checkTorRunning() {
    const { exec } = require('child_process');
    return new Promise((resolve) => {
      exec('pgrep -x tor', (error, stdout) => {
        resolve(stdout.trim() !== '');
      });
    });
  }
  
  async autoFixTorService() {
    const torRunning = await this.checkTorRunning();
    if (!torRunning) {
      this.log('warning', 'Tor not running - please start Tor service manually');
    }
  }

  loadConfig() {
    try {
      if (fs.existsSync(CONFIG_FILE)) {
        const data = fs.readFileSync(CONFIG_FILE, 'utf8');
        return JSON.parse(data);
      }
    } catch (error) {
      console.error('Error loading FaucetSentry config:', error.message);
    }
    return {
      bankWalletName: null,
      connectionType: 'direct',
      proxyUrl: null,
      torEnabled: false,
      claimInterval: 24
    };
  }

  saveConfig() {
    try {
      const dir = path.dirname(CONFIG_FILE);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      fs.writeFileSync(CONFIG_FILE, JSON.stringify(this.config, null, 2));
    } catch (error) {
      console.error('Error saving FaucetSentry config:', error.message);
    }
  }

  log(level, message, metadata = {}) {
    const entry = {
      id: uuidv4(),
      timestamp: new Date().toISOString(),
      level,
      message,
      metadata
    };

    this.logs.unshift(entry);
    if (this.logs.length > this.maxLogs) {
      this.logs.pop();
    }

    stateManager.addFaucetLog(entry);
    this.io.emit('faucet-log', entry);

    const icon = {
      info: 'ℹ️',
      success: '✅',
      warning: '⚠️',
      error: '❌',
      action: '🎯'
    }[level] || '📝';

    console.log(`${icon} [FaucetSentry] ${message}`);

    return entry;
  }

  getLogs(limit = 100) {
    return this.logs.slice(0, limit);
  }

  clearLogs() {
    this.logs = [];
    stateManager.clearLogs('faucet');
  }

  getStatus() {
    return {
      isRunning: this.isRunning,
      isPaused: this.isPaused,
      config: this.config,
      sessionStats: this.sessionStats,
      gpuWorkerUrl: this.nanoWallet.gpuWorkerUrl,
      autoRestartEnabled: this.autoRestartEnabled
    };
  }

  setAutoRestart(enabled) {
    this.autoRestartEnabled = enabled;
    this.log('info', `Auto-restart ${enabled ? 'enabled' : 'disabled'}`);
    this.emitStatus();
    return { success: true, autoRestartEnabled: this.autoRestartEnabled };
  }

  async setBankWallet(walletName) {
    if (!walletName) {
      this.config.bankWalletName = null;
      this.saveConfig();
      return { success: true };
    }

    const walletInfo = this.nanoWallet.getWalletInfo(walletName);
    if (!walletInfo) {
      return { success: false, error: 'Wallet not found' };
    }

    this.config.bankWalletName = walletName;
    this.saveConfig();
    this.log('info', `Bank wallet set to: ${walletName}`);
    return { success: true, wallet: walletInfo };
  }

  setConnectionType(type, proxyUrl = null) {
    if (!['direct', 'proxy', 'tor'].includes(type)) {
      return { success: false, error: 'Invalid connection type' };
    }

    this.config.connectionType = type;
    this.config.proxyUrl = proxyUrl;
    this.config.torEnabled = type === 'tor';
    this.saveConfig();
    this.log('info', `Connection type set to: ${type}`);
    return { success: true };
  }

  async getBankWalletBalance() {
    if (!this.config.bankWalletName) {
      return { success: false, error: 'No bank wallet configured' };
    }

    try {
      const result = await this.nanoWallet.syncWallet(this.config.bankWalletName);
      if (result.success) {
        return {
          success: true,
          balance: result.balance,
          pending: result.pending,
          address: result.address
        };
      }
      return { success: false, error: result.error };
    } catch (error) {
      return { success: false, error: error.message };
    }
  }

  generateRandomUserAgent() {
    const chromeVersions = ['120', '121', '122', '123', '124', '125', '126', '127', '128', '129', '130', '131'];
    const firefoxVersions = ['121', '122', '123', '124', '125', '126', '127', '128', '129', '130'];
    const edgeVersions = ['120', '121', '122', '123', '124', '125', '126'];
    const safariVersions = ['17.2', '17.3', '17.4', '17.5', '18.0'];
    
    const windowsPlatforms = [
      'Windows NT 10.0; Win64; x64',
      'Windows NT 10.0; WOW64',
      'Windows NT 11.0; Win64; x64'
    ];
    
    const macPlatforms = [
      'Macintosh; Intel Mac OS X 10_15_7',
      'Macintosh; Intel Mac OS X 11_0',
      'Macintosh; Intel Mac OS X 12_0',
      'Macintosh; Intel Mac OS X 13_0',
      'Macintosh; Intel Mac OS X 14_0',
      'Macintosh; Intel Mac OS X 14_1'
    ];
    
    const linuxPlatforms = [
      'X11; Linux x86_64',
      'X11; Ubuntu; Linux x86_64',
      'X11; Fedora; Linux x86_64'
    ];
    
    const platformWeights = [
      { platforms: windowsPlatforms, weight: 55, browsers: ['chrome', 'firefox', 'edge'] },
      { platforms: macPlatforms, weight: 30, browsers: ['chrome', 'firefox', 'safari'] },
      { platforms: linuxPlatforms, weight: 15, browsers: ['chrome', 'firefox'] }
    ];
    
    // Select platform group by weight
    const random = Math.random() * 100;
    let cumulative = 0;
    let selectedGroup = platformWeights[0];
    
    for (const group of platformWeights) {
      cumulative += group.weight;
      if (random <= cumulative) {
        selectedGroup = group;
        break;
      }
    }
    
    const selectedPlatform = selectedGroup.platforms[Math.floor(Math.random() * selectedGroup.platforms.length)];
    const availableBrowsers = selectedGroup.browsers;
    const selectedBrowser = availableBrowsers[Math.floor(Math.random() * availableBrowsers.length)];
    
    // Generate more realistic build numbers
    const majorVersion = (v) => parseInt(v);
    const minorVersion = () => Math.floor(Math.random() * 10);
    const buildNumber = () => Math.floor(Math.random() * 9999) + 1000;
    const patchNumber = () => Math.floor(Math.random() * 200);
    
    let userAgent;
    
    switch (selectedBrowser) {
      case 'chrome': {
        const version = chromeVersions[Math.floor(Math.random() * chromeVersions.length)];
        const build = buildNumber();
        const patch = patchNumber();
        userAgent = `Mozilla/5.0 (${selectedPlatform}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${version}.0.${build}.${patch} Safari/537.36`;
        break;
      }
      case 'firefox': {
        const version = firefoxVersions[Math.floor(Math.random() * firefoxVersions.length)];
        userAgent = `Mozilla/5.0 (${selectedPlatform}; rv:${version}.0) Gecko/20100101 Firefox/${version}.0`;
        break;
      }
      case 'edge': {
        const version = edgeVersions[Math.floor(Math.random() * edgeVersions.length)];
        const build = buildNumber();
        const patch = patchNumber();
        userAgent = `Mozilla/5.0 (${selectedPlatform}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${version}.0.${build}.${patch} Safari/537.36 Edg/${version}.0.${build}.${patch}`;
        break;
      }
      case 'safari': {
        const version = safariVersions[Math.floor(Math.random() * safariVersions.length)];
        userAgent = `Mozilla/5.0 (${selectedPlatform}) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/${version} Safari/605.1.15`;
        break;
      }
      default: {
        const version = chromeVersions[Math.floor(Math.random() * chromeVersions.length)];
        userAgent = `Mozilla/5.0 (${selectedPlatform}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${version}.0.0.0 Safari/537.36`;
      }
    }
    
    // Ensure we don't reuse the same user agent
    if (this.usedUserAgents.has(userAgent)) {
      // Regenerate with slightly modified build/patch numbers
      return this.generateRandomUserAgent();
    }
    
    this.usedUserAgents.add(userAgent);
    
    // Limit user agent history
    if (this.usedUserAgents.size > this.maxIPHistory) {
      const firstUA = this.usedUserAgents.values().next().value;
      this.usedUserAgents.delete(firstUA);
    }
    
    return userAgent;
  }

  findChromePath() {
    const { execSync } = require('child_process');
    
    try {
      const result = execSync('which chromium || which chromium-browser || which google-chrome', { encoding: 'utf8' });
      const path = result.trim();
      if (path && fs.existsSync(path)) {
        return path;
      }
    } catch (e) {}

    if (process.env.CHROME_PATH && fs.existsSync(process.env.CHROME_PATH)) {
      return process.env.CHROME_PATH;
    }

    const possiblePaths = [
      '/usr/bin/chromium-browser',
      '/usr/bin/chromium',
      '/usr/bin/google-chrome',
      '/usr/bin/google-chrome-stable',
      '/snap/bin/chromium'
    ];

    for (const p of possiblePaths) {
      if (fs.existsSync(p)) return p;
    }

    throw new Error('Chrome/Chromium not found');
  }

  async createTemporaryClaimWallet() {
    const tempName = `_temp_claim_${Date.now()}`;
    const newWallet = wallet.generate();
    const account = newWallet.accounts[0];

    this.claimWallet = {
      name: tempName,
      seed: newWallet.seed,
      address: account.address,
      publicKey: account.publicKey,
      privateKey: account.privateKey
    };

    this.sessionStats.tempClaimWallet = account.address;
    this.log('success', `Created temporary claim wallet: ${account.address.substring(0, 20)}...`);
    
    return this.claimWallet;
  }

  async deleteTemporaryClaimWallet() {
    if (this.claimWallet) {
      this.log('info', `Deleting temporary claim wallet: ${this.claimWallet.address.substring(0, 20)}...`);
      this.claimWallet = null;
      this.sessionStats.tempClaimWallet = null;
    }
  }

  async generateWork(hash) {
    const gpuWorkerUrl = this.nanoWallet.gpuWorkerUrl;
    
    if (gpuWorkerUrl) {
      try {
        const response = await fetch(gpuWorkerUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            action: 'work_generate',
            hash: hash,
            difficulty: 'fffffff800000000'
          }),
          signal: AbortSignal.timeout(30000)
        });

        const data = await response.json();
        if (data.work) {
          this.log('info', 'PoW generated via GPU worker');
          return data.work;
        }
      } catch (error) {
        this.log('warning', 'GPU worker unavailable, using public RPC');
      }
    }

    const response = await fetch(POW_RPC_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        action: 'work_generate',
        hash: hash,
        difficulty: 'fffffff800000000'
      }),
      signal: AbortSignal.timeout(60000)
    });

    if (!response.ok) {
      throw new Error(`Work generation failed with status ${response.status}`);
    }

    const data = await response.json();
    if (data.error) {
      throw new Error(`Work generation failed: ${data.error}`);
    }

    return data.work;
  }

  async getAccountInfo(address) {
    const response = await fetch(RPC_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        action: 'account_info',
        account: address,
        representative: true,
        pending: true
      })
    });

    const data = await response.json();

    if (data.error === 'Account not found') {
      return {
        opened: false,
        balance: '0',
        pending: '0',
        frontier: '0000000000000000000000000000000000000000000000000000000000000000'
      };
    }

    if (data.error) throw new Error(data.error);

    return {
      opened: true,
      balance: data.balance,
      balanceNano: tools.convert(data.balance, 'RAW', 'NANO'),
      pending: data.pending || '0',
      pendingNano: data.pending ? tools.convert(data.pending, 'RAW', 'NANO') : '0',
      frontier: data.frontier,
      representative: data.representative,
      blockCount: data.block_count
    };
  }

  async getPendingBlocks(address) {
    let lastError = null;
    
    for (const rpcUrl of RPC_FALLBACK_URLS) {
      try {
        const response = await fetch(rpcUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            action: 'pending',
            account: address,
            count: 10,
            source: true,
            include_only_confirmed: true
          }),
          signal: AbortSignal.timeout(10000)
        });

        const data = await response.json();

        if (data.error && data.error !== 'Account not found') {
          lastError = new Error(data.error);
          continue;
        }

        const blocks = data.blocks || {};
        const pendingList = Object.entries(blocks).map(([hash, info]) => ({
          hash,
          amount: info.amount,
          amountNano: tools.convert(info.amount, 'RAW', 'NANO'),
          source: info.source
        }));
        
        if (pendingList.length > 0) {
          return pendingList;
        }
      } catch (error) {
        lastError = error;
      }
    }
    
    if (lastError && lastError.message !== 'Account not found') {
      this.log('warning', `RPC issue checking pending: ${lastError.message}`);
    }
    
    return [];
  }
  
  async getPendingFromAccountInfo(address) {
    for (const rpcUrl of RPC_FALLBACK_URLS) {
      try {
        const response = await fetch(rpcUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            action: 'account_info',
            account: address,
            pending: true
          }),
          signal: AbortSignal.timeout(10000)
        });

        const data = await response.json();
        
        if (data.pending && BigInt(data.pending) > 0) {
          return tools.convert(data.pending, 'RAW', 'NANO');
        }
      } catch (error) {
        continue;
      }
    }
    return '0';
  }

  async processBlock(signedBlock) {
    const response = await fetch(RPC_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        action: 'process',
        json_block: 'true',
        block: signedBlock
      })
    });

    const data = await response.json();
    if (data.error) throw new Error(data.error);
    return data.hash;
  }

  async sendFromWallet(fromWallet, toAddress, amountNano) {
    const accountInfo = await this.getAccountInfo(fromWallet.address);
    
    if (!accountInfo.opened) {
      throw new Error('Account not opened yet');
    }

    const amountRaw = tools.convert(amountNano, 'NANO', 'RAW');

    if (BigInt(amountRaw) > BigInt(accountInfo.balance)) {
      throw new Error('Insufficient balance');
    }

    this.log('info', 'Generating proof of work for send...');
    const work = await this.generateWork(accountInfo.frontier);

    const sendBlockData = block.send({
      walletBalanceRaw: accountInfo.balance,
      fromAddress: fromWallet.address,
      toAddress: toAddress,
      representativeAddress: accountInfo.representative || 'nano_3kc8wwut3u8g1kwa6x4drkzu346bdbyqzsn14tmabrpeobn8igksfqkzajbb',
      frontier: accountInfo.frontier,
      amountRaw: amountRaw,
      work: work
    }, fromWallet.privateKey);

    const hash = await this.processBlock(sendBlockData);
    return hash;
  }

  async receiveToWallet(toWallet, pendingHash, amountRaw) {
    const accountInfo = await this.getAccountInfo(toWallet.address);

    const representative = accountInfo.representative ||
      'nano_3kc8wwut3u8g1kwa6x4drkzu346bdbyqzsn14tmabrpeobn8igksfqkzajbb';

    const workHash = accountInfo.opened ? accountInfo.frontier : toWallet.publicKey;

    this.log('info', 'Generating proof of work for receive...');
    const work = await this.generateWork(workHash);

    const receiveBlockData = block.receive({
      walletBalanceRaw: accountInfo.balance,
      toAddress: toWallet.address,
      representativeAddress: representative,
      frontier: accountInfo.frontier,
      transactionHash: pendingHash,
      amountRaw: amountRaw,
      work: work
    }, toWallet.privateKey);

    const hash = await this.processBlock(receiveBlockData);
    return hash;
  }

  async receiveAllPending(walletData) {
    const pending = await this.getPendingBlocks(walletData.address);
    
    if (pending.length === 0) {
      return { received: 0, total: '0' };
    }

    let totalReceived = BigInt(0);

    for (const p of pending) {
      try {
        await this.receiveToWallet(walletData, p.hash, p.amount);
        totalReceived += BigInt(p.amount);
        this.log('success', `Received ${p.amountNano} NANO`);
      } catch (error) {
        this.log('error', `Failed to receive: ${error.message}`);
      }
    }

    return {
      received: pending.length,
      total: tools.convert(totalReceived.toString(), 'RAW', 'NANO')
    };
  }

  async waitForPending(address, timeout = 1800000, checkInterval = 1000) {
    const startTime = Date.now();
    let consecutiveEmptyChecks = 0;
    const maxEmptyBeforeBackup = 3;

    while (Date.now() - startTime < timeout) {
      if (!this.isRunning || this.isPaused) {
        throw new Error('Session stopped or paused');
      }

      const pending = await this.getPendingBlocks(address);
      
      if (pending.length > 0) {
        this.log('success', `Pending transaction detected via RPC!`);
        return pending;
      }
      
      consecutiveEmptyChecks++;
      
      if (consecutiveEmptyChecks >= maxEmptyBeforeBackup) {
        const pendingAmount = await this.getPendingFromAccountInfo(address);
        if (parseFloat(pendingAmount) > 0) {
          this.log('info', `Account shows ${pendingAmount} NANO pending, retrying block fetch...`);
          await this.delay(3000);
          
          const retryPending = await this.getPendingBlocks(address);
          if (retryPending.length > 0) {
            return retryPending;
          }
          
          this.log('warning', `Pending amount exists but blocks not returned - RPC sync issue, will keep trying...`);
        }
        consecutiveEmptyChecks = 0;
      }

      const elapsed = Math.floor((Date.now() - startTime) / 1000);
      this.log('info', `Waiting for reward... (${elapsed}s elapsed)`);
      await this.delay(checkInterval);
    }

    throw new Error('Timeout waiting for pending transaction');
  }

  async startClaimSession() {
    if (this.isRunning) {
      return { success: false, error: 'Session already running' };
    }

    if (!this.config.bankWalletName) {
      return { success: false, error: 'No bank wallet configured' };
    }

    const bankBalance = await this.getBankWalletBalance();
    if (!bankBalance.success) {
      return { success: false, error: bankBalance.error };
    }

    if (parseFloat(bankBalance.balance) < MIN_BANK_BALANCE) {
      return { success: false, error: `Bank wallet needs at least ${MIN_BANK_BALANCE} NANO` };
    }

    this.isRunning = true;
    this.isPaused = false;
    this.sessionStats.status = 'starting';
    this.emitStatus();

    this.runClaimProcess().catch(err => {
      this.log('error', `Claim session failed: ${err.message}`);
      this.sessionStats.status = 'failed';
      this.cleanup();
      
      // For Tor/Proxy modes: Any error triggers instant new session
      if (this.config.connectionType !== 'direct' && this.autoRestartEnabled) {
        this.log('info', 'Error caught at session level! Creating new session instantly...');
        this.scheduleAutoRestart(500);
      }
    });

    return { success: true };
  }

  async runClaimProcess() {
    try {
      this.sessionStats.status = 'creating_temp_wallet';
      this.emitStatus();

      const claimWallet = await this.createTemporaryClaimWallet();

      this.sessionStats.status = 'launching_browser';
      this.emitStatus();

      await this.launchBrowser();

      this.sessionStats.status = 'navigating';
      this.emitStatus();

      this.log('action', 'Navigating to faucet...');
      await this.page.goto(FAUCET_URL, { waitUntil: 'networkidle2', timeout: 60000 });
      
      // Wait for page to be fully ready (important for slow proxies)
      await this.page.waitForSelector('body', { timeout: 30000 }).catch(() => {
        this.log('warning', 'Body selector timeout, continuing anyway...');
      });
      await this.delay(3000);

      await this.takeScreenshot('Faucet page loaded');

      this.sessionStats.status = 'entering_address';
      this.emitStatus();

      this.log('action', 'Entering claim wallet address...');
      const addressInput = await this.page.$('input[type="text"], input[name*="wallet"], input[name*="address"], input[placeholder*="wallet"], input[placeholder*="address"], input');
      
      if (!addressInput) {
        throw new Error('Could not find wallet address input field');
      }

      await addressInput.click();
      await this.delay(500);
      await addressInput.type(claimWallet.address, { delay: 50 });
      await this.delay(1000);

      await this.takeScreenshot('Address entered');

      this.sessionStats.status = 'clicking_claim';
      this.emitStatus();

      this.log('action', 'Clicking claim button...');
      
      const claimButton = await this.page.evaluateHandle(() => {
        const buttons = Array.from(document.querySelectorAll('button, input[type="submit"]'));
        return buttons.find(btn => 
          btn.textContent.toLowerCase().includes('get free') ||
          btn.textContent.toLowerCase().includes('claim') ||
          btn.value?.toLowerCase().includes('get free')
        );
      });

      if (!claimButton) {
        throw new Error('Could not find claim button');
      }

      await claimButton.click();
      
      // Wait for page to update after clicking (important for slow proxies)
      this.log('info', 'Waiting for page response after click...');
      await Promise.race([
        this.page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 30000 }).catch(() => null),
        this.delay(5000)
      ]);
      
      // Extra wait for DOM to render
      await this.page.waitForSelector('body', { timeout: 10000 }).catch(() => null);
      await this.delay(2000);

      await this.takeScreenshot('After clicking claim');

      this.sessionStats.status = 'extracting_donation';
      this.emitStatus();

      this.log('action', 'Waiting for donation amount to load...');
      
      // Smart wait: Keep checking until donation amount appears or timeout
      const maxWaitTime = 60000; // 60 seconds max wait for slow proxies
      const checkInterval = 2000; // Check every 2 seconds
      const startWait = Date.now();
      
      let pageContent = '';
      let pageText = '';
      let donationMatch = null;
      let hasRateLimitError = false;
      
      const comeBackPatterns = [
        'come back tomorrow',
        'already claimed',
        'try again later',
        'wait 24 hours',
        'exceeded limit',
        'too many requests',
        'rate limit',
        'quota exceeded',
        'daily limit'
      ];
      
      while (Date.now() - startWait < maxWaitTime) {
        try {
          // Wait for body to be available first
          await this.page.waitForSelector('body', { timeout: 5000 }).catch(() => null);
          
          pageContent = await this.page.content();
          pageText = await this.page.evaluate(() => {
            if (document.body && document.body.innerText) {
              return document.body.innerText.toLowerCase();
            }
            return '';
          });
          
          // Check for rate limit first
          hasRateLimitError = comeBackPatterns.some(pattern => pageText.includes(pattern));
          if (hasRateLimitError) {
            break;
          }
          
          // Try to find donation amount
          donationMatch = pageContent.match(/Send\s*([\d.]+)\s*XNO/i) || 
                         pageContent.match(/([\d.]+)\s*XNO\s*to\s*donation/i) ||
                         pageContent.match(/send\s*([\d.]+)/i);
          
          if (donationMatch) {
            this.log('success', `Donation amount detected after ${Math.round((Date.now() - startWait) / 1000)}s`);
            break;
          }
        } catch (pageError) {
          this.log('warning', `Page check error: ${pageError.message.substring(0, 50)}`);
        }
        
        const elapsed = Math.round((Date.now() - startWait) / 1000);
        this.log('info', `Waiting for page to load... (${elapsed}s)`);
        await this.takeScreenshot(`Loading... ${elapsed}s`);
        await this.delay(checkInterval);
      }
      
      if (hasRateLimitError) {
        this.log('warning', 'Rate limit detected - "come back tomorrow" or similar message found');
        await this.takeScreenshot('Rate limit detected');
        
        // For Tor/Proxy, auto-restart with new identity
        if (this.config.connectionType !== 'direct' && this.autoRestartEnabled) {
          this.log('info', 'Tor/Proxy mode: Will restart with new identity...');
          throw new Error('RATE_LIMIT_RETRY');
        } else {
          throw new Error('Rate limit reached - please try again tomorrow');
        }
      }

      if (!donationMatch) {
        await this.takeScreenshot('Failed to find donation amount');
        throw new Error('Could not extract donation amount from page (timeout - page may still be loading)');
      }

      const donationAmount = donationMatch[1];
      this.log('success', `Donation amount required: ${donationAmount} NANO`);

      await this.takeScreenshot(`Donation: ${donationAmount} NANO`);

      this.sessionStats.status = 'funding_claim_wallet';
      this.emitStatus();

      this.log('action', `Sending ${donationAmount} NANO from Bank to Claim wallet...`);
      
      const bankWalletData = this.getBankWalletData();
      if (!bankWalletData) {
        throw new Error('Bank wallet data not found');
      }

      await this.nanoWallet.sendNano(this.config.bankWalletName, claimWallet.address, donationAmount);
      this.sessionStats.lastDonationSent = new Date().toISOString();
      this.log('success', 'Sent NANO to claim wallet');

      this.sessionStats.status = 'receiving_to_claim';
      this.emitStatus();

      this.log('action', 'Waiting for claim wallet to receive NANO...');
      await this.delay(5000);

      let retries = 0;
      while (retries < 30) {
        const pending = await this.getPendingBlocks(claimWallet.address);
        if (pending.length > 0) {
          await this.receiveAllPending(claimWallet);
          break;
        }
        await this.delay(2000);
        retries++;
      }

      if (retries >= 30) {
        throw new Error('Claim wallet did not receive NANO in time');
      }

      this.sessionStats.status = 'sending_donation';
      this.emitStatus();

      this.log('action', `Sending donation to faucet: ${FAUCET_DONATION_ADDRESS.substring(0, 20)}...`);
      await this.sendFromWallet(claimWallet, FAUCET_DONATION_ADDRESS, donationAmount);
      this.log('success', 'Donation sent to faucet!');

      await this.takeScreenshot('Donation sent');

      this.sessionStats.status = 'waiting_reward';
      this.emitStatus();

      this.log('action', 'Waiting for faucet reward (this may take up to 30 minutes)...');

      const rewardPending = await this.waitForPending(claimWallet.address, 1800000, 1000);

      this.sessionStats.status = 'receiving_reward';
      this.emitStatus();

      this.log('success', `Reward received! Amount: ${rewardPending[0].amountNano} NANO`);
      this.sessionStats.lastRewardReceived = new Date().toISOString();

      await this.receiveAllPending(claimWallet);

      this.sessionStats.status = 'sending_to_bank';
      this.emitStatus();

      const claimAccountInfo = await this.getAccountInfo(claimWallet.address);
      const fullBalance = claimAccountInfo.balanceNano;

      this.log('action', `Sending ${fullBalance} NANO to Bank wallet...`);
      
      const bankAddress = bankWalletData.accounts[0].address;
      await this.sendFromWallet(claimWallet, bankAddress, fullBalance);

      this.log('success', `Sent ${fullBalance} NANO to Bank wallet!`);

      // Bug 1 Fix: Wait briefly for network propagation, then call receiveNano atomically
      this.sessionStats.status = 'receiving_to_bank';
      this.emitStatus();
      this.log('action', 'Processing bank wallet receive...');
      
      await this.delay(3000);
      
      try {
        const receiveResult = await this.nanoWallet.receiveNano(this.config.bankWalletName);
        if (receiveResult.success && receiveResult.received > 0) {
          this.log('success', `Bank wallet received ${receiveResult.received} transaction(s) successfully!`);
        } else if (receiveResult.success) {
          this.log('info', 'Bank wallet sync complete - no pending blocks');
        } else {
          this.log('warning', `Bank wallet receive issue: ${receiveResult.error || 'unknown'}`);
        }
      } catch (err) {
        this.log('warning', `Bank wallet receive failed: ${err.message}`);
      }

      // Bug 3 Fix: Sum ALL reward blocks for net reward calculation
      const totalRewardAmount = rewardPending.reduce((sum, block) => sum + parseFloat(block.amountNano), 0);
      const donationNum = parseFloat(donationAmount);
      const netReward = totalRewardAmount - donationNum;
      
      // Always count the claim, but only add positive rewards to totals
      this.sessionStats.totalClaims++;
      if (netReward > 0) {
        this.sessionStats.totalRewards = (parseFloat(this.sessionStats.totalRewards) + netReward).toFixed(6);
        this.log('success', `🎉 Claim session completed successfully! Net reward: ${netReward.toFixed(6)} NANO`);
      } else {
        this.log('warning', `Claim completed but net reward is ${netReward.toFixed(6)} NANO (not profitable)`);
      }
      
      this.sessionStats.nextClaimAvailable = new Date(Date.now() + this.config.claimInterval * 3600000).toISOString();

      await this.deleteTemporaryClaimWallet();
      await this.cleanup();

      this.sessionStats.status = 'completed';
      this.sessionStats.consecutiveSessions++;
      this.emitStatus();

      // Auto-restart for Tor/Proxy modes after successful claim - INSTANT START
      if (this.config.connectionType !== 'direct' && this.autoRestartEnabled) {
        this.log('success', `Session ${this.sessionStats.consecutiveSessions} completed! Auto-starting new session with fresh identity instantly...`);
        
        // Schedule auto-restart immediately (500ms just for cleanup)
        this.scheduleAutoRestart(500);
      } else {
        this.log('info', 'Session completed. Manual restart required for direct connection.');
      }

    } catch (error) {
      this.log('error', `Claim process error: ${error.message}`);
      this.sessionStats.status = 'failed';
      await this.deleteTemporaryClaimWallet();
      await this.cleanup();
      
      // For Tor/Proxy modes: ANY error should trigger instant retry with fresh identity
      // No more error list - just restart immediately on any failure
      if (this.config.connectionType !== 'direct' && this.autoRestartEnabled) {
        this.log('info', 'Error detected! Creating new session with fresh identity instantly...');
        
        // Schedule auto-restart immediately
        this.scheduleAutoRestart(500);
        return;
      }
      
      // For direct connection, throw the error
      throw error;
    }
  }

  async scheduleAutoRestart(delayMs) {
    await this.delay(delayMs);
    
    if (!this.autoRestartEnabled) {
      this.log('info', 'Auto-restart was disabled during wait, not restarting.');
      return;
    }
    
    // Request new Tor identity with strict timeout
    if (this.config.connectionType === 'tor') {
      this.log('info', 'Requesting fresh Tor identity...');
      
      const torIdentityPromise = this.getVerifiedFreshTorIdentity();
      const timeoutPromise = new Promise(resolve => setTimeout(() => resolve({ timeout: true }), 15000));
      
      const result = await Promise.race([torIdentityPromise, timeoutPromise]);
      
      if (result && result.timeout) {
        this.log('warning', 'Tor identity timeout - proceeding anyway');
      }
    }
    
    this.log('info', 'Starting new claim session...');
    
    try {
      const result = await this.startClaimSession();
      if (!result.success) {
        this.log('error', `Auto-restart failed: ${result.error}`);
      }
    } catch (err) {
      this.log('error', `Session error: ${err.message}`);
    }
  }
  
  async getVerifiedFreshTorIdentity() {
    let attempts = 0;
    const maxAttempts = 3;
    
    while (attempts < maxAttempts) {
      attempts++;
      
      await this.requestNewTorIdentity();
      await this.delay(2000);
      
      try {
        const currentIP = await this.getCurrentTorIP();
        
        if (currentIP && currentIP.length > 6) {
          if (!this.usedTorIPs.has(currentIP)) {
            this.usedTorIPs.add(currentIP);
            
            if (this.usedTorIPs.size > this.maxIPHistory) {
              const firstIP = this.usedTorIPs.values().next().value;
              this.usedTorIPs.delete(firstIP);
            }
            
            this.log('success', `Fresh Tor IP: ${currentIP}`);
            return { success: true, ip: currentIP };
          } else {
            this.log('warning', `IP ${currentIP} already used (attempt ${attempts}/${maxAttempts})`);
          }
        } else {
          this.log('info', 'Could not verify IP, proceeding');
          return { success: true };
        }
      } catch (err) {
        this.log('info', 'IP check skipped');
        return { success: true };
      }
    }
    
    this.log('warning', 'Max identity attempts - clearing IP history');
    this.usedTorIPs.clear();
    return { success: true };
  }
  
  async getCurrentTorIP() {
    const https = require('https');
    const { SocksProxyAgent } = require('socks-proxy-agent');
    
    return new Promise((resolve) => {
      const timeout = setTimeout(() => resolve(null), 8000);
      
      try {
        const agent = new SocksProxyAgent(`socks5://127.0.0.1:${this.torSocksPort}`);
        const req = https.get({
          hostname: 'api.ipify.org',
          path: '/?format=text',
          agent: agent,
          timeout: 7000
        }, (res) => {
          let data = '';
          res.on('data', chunk => data += chunk);
          res.on('end', () => {
            clearTimeout(timeout);
            resolve(data.trim() || null);
          });
        });
        
        req.on('error', () => {
          clearTimeout(timeout);
          resolve(null);
        });
        
        req.on('timeout', () => {
          req.destroy();
          clearTimeout(timeout);
          resolve(null);
        });
      } catch (err) {
        clearTimeout(timeout);
        resolve(null);
      }
    });
  }

  getBankWalletData() {
    if (!this.config.bankWalletName) return null;
    return this.nanoWallet.wallets[this.config.bankWalletName];
  }

  parseProxyUrl(proxyUrl) {
    if (!proxyUrl) return null;
    
    try {
      const match = proxyUrl.match(/^(?:(https?):\/\/)?(?:([^:@]+):([^@]+)@)?([^:\/]+)(?::(\d+))?/);
      if (match) {
        return {
          protocol: match[1] || 'http',
          username: match[2] ? decodeURIComponent(match[2]) : null,
          password: match[3] ? decodeURIComponent(match[3]) : null,
          host: match[4],
          port: match[5] || '80'
        };
      }
    } catch (e) {
      this.log('warning', `Failed to parse proxy URL: ${e.message}`);
    }
    return null;
  }

  async launchBrowser() {
    const { connect } = require('../lib/cjs/index.js');

    const chromePath = this.findChromePath();
    this.log('info', `Using Chrome at: ${chromePath}`);

    const args = [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--disable-software-rasterizer',
      '--disable-background-networking',
      '--disable-default-apps',
      '--disable-extensions',
      '--disable-sync',
      '--no-first-run',
      '--remote-debugging-port=0'
    ];

    let proxyAuth = null;

    if (this.config.connectionType === 'proxy' && this.config.proxyUrl) {
      const parsed = this.parseProxyUrl(this.config.proxyUrl);
      if (parsed) {
        args.push(`--proxy-server=${parsed.host}:${parsed.port}`);
        this.log('info', `Using proxy: ${parsed.host}:${parsed.port}`);
        if (parsed.username && parsed.password) {
          proxyAuth = { username: parsed.username, password: parsed.password };
          this.log('info', `Proxy authentication enabled for user: ${parsed.username.substring(0, 10)}...`);
        }
      } else {
        args.push(`--proxy-server=${this.config.proxyUrl}`);
        this.log('info', `Using proxy: ${this.config.proxyUrl}`);
      }
    } else if (this.config.connectionType === 'tor') {
      args.push(`--proxy-server=socks5://127.0.0.1:${this.torSocksPort}`);
      this.log('info', `Using Tor network on port ${this.torSocksPort}`);
    }

    const { browser, page } = await connect({
      headless: 'new',
      turnstile: true,
      disableXvfb: true,
      args: args,
      customConfig: {
        chromePath: chromePath
      },
      connectOption: {
        defaultViewport: { width: 1280, height: 720 }
      }
    });

    this.browser = browser;
    this.page = page;

    if (proxyAuth) {
      await page.authenticate(proxyAuth);
      this.log('info', 'Proxy authentication credentials set');
    }

    const userAgent = this.generateRandomUserAgent();
    await page.setUserAgent(userAgent);
    this.log('info', `User Agent: ${userAgent.substring(0, 50)}...`);

    page.on('console', msg => {
      if (msg.type() === 'error') {
        this.log('warning', `Console: ${msg.text().substring(0, 100)}`);
      }
    });
  }

  async takeScreenshot(label) {
    try {
      if (this.page) {
        const screenshot = await this.page.screenshot({ encoding: 'base64', type: 'jpeg', quality: 60 });
        this.io.emit('faucet-screenshot', { image: screenshot, label, isLive: true });
        stateManager.setFaucetScreenshot(screenshot, label);
      }
    } catch (error) {
      this.log('warning', 'Failed to take screenshot');
    }
  }

  async cleanup() {
    this.isRunning = false;
    
    if (this.browser) {
      try {
        await this.browser.close();
      } catch (e) {}
      this.browser = null;
      this.page = null;
    }

    this.emitStatus();
  }

  async stopSession() {
    this.log('info', 'Stopping claim session...');
    this.isRunning = false;
    this.isPaused = false;
    
    await this.deleteTemporaryClaimWallet();
    await this.cleanup();
    
    this.sessionStats.status = 'stopped';
    this.emitStatus();

    return { success: true };
  }

  pauseSession() {
    if (!this.isRunning) {
      return { success: false, error: 'No session running' };
    }
    this.isPaused = !this.isPaused;
    this.sessionStats.status = this.isPaused ? 'paused' : 'running';
    this.emitStatus();
    this.log('info', this.isPaused ? 'Session paused' : 'Session resumed');
    return { success: true, paused: this.isPaused };
  }

  emitStatus() {
    this.io.emit('faucet-status', this.getStatus());
  }

  delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  async requestNewTorIdentity() {
    try {
      this.log('info', 'Requesting new Tor identity...');
      const net = require('net');
      
      return new Promise((resolve, reject) => {
        const client = new net.Socket();
        const timeout = setTimeout(() => {
          client.destroy();
          this.log('warning', 'Tor control connection timed out');
          resolve();
        }, 5000);

        client.connect(this.torControlPort, '127.0.0.1', () => {
          client.write('AUTHENTICATE ""\r\n');
        });

        client.on('data', (data) => {
          const response = data.toString();
          if (response.includes('250')) {
            if (response.includes('OK') && !response.includes('NEWNYM')) {
              client.write('SIGNAL NEWNYM\r\n');
            } else {
              clearTimeout(timeout);
              client.destroy();
              this.log('success', 'New Tor identity obtained');
              resolve();
            }
          } else if (response.includes('515')) {
            clearTimeout(timeout);
            client.destroy();
            this.log('warning', 'Tor control auth failed - new identity not requested');
            resolve();
          }
        });

        client.on('error', (err) => {
          clearTimeout(timeout);
          this.log('warning', `Tor control connection error: ${err.message}`);
          resolve();
        });
      });
    } catch (error) {
      this.log('warning', `Failed to request new Tor identity: ${error.message}`);
    }
  }
}

module.exports = { FaucetSentry };
