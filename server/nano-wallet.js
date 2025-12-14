const { wallet, block, tools } = require('nanocurrency-web');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const WALLETS_FILE = path.join(__dirname, '../data/nano-wallets.enc');
const CONFIG_FILE = path.join(__dirname, '../data/nano-config.json');
const RPC_URL = 'http://157.230.168.241:7076';
const POW_RPC_URL = 'https://rainstorm.city/api';
const POW_FALLBACK_URLS = [
  'https://rainstorm.city/api',
  'https://node.somenano.com/proxy',
  'https://proxy.nanos.cc/proxy'
];
const ALGORITHM = 'aes-256-gcm';

function getEncryptionKey() {
  const key = process.env.NANO_WALLET_KEY || process.env.SESSION_SECRET || 'default-dev-key-change-in-production';
  return crypto.createHash('sha256').update(key).digest();
}

function encrypt(text) {
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv(ALGORITHM, getEncryptionKey(), iv);
  let encrypted = cipher.update(text, 'utf8', 'hex');
  encrypted += cipher.final('hex');
  const authTag = cipher.getAuthTag();
  return iv.toString('hex') + ':' + authTag.toString('hex') + ':' + encrypted;
}

function decrypt(encryptedData) {
  const parts = encryptedData.split(':');
  if (parts.length !== 3) throw new Error('Invalid encrypted data format');
  const iv = Buffer.from(parts[0], 'hex');
  const authTag = Buffer.from(parts[1], 'hex');
  const encrypted = parts[2];
  const decipher = crypto.createDecipheriv(ALGORITHM, getEncryptionKey(), iv);
  decipher.setAuthTag(authTag);
  let decrypted = decipher.update(encrypted, 'hex', 'utf8');
  decrypted += decipher.final('utf8');
  return decrypted;
}

function isValidNanoAddress(address) {
  if (!address || typeof address !== 'string') return false;
  const nanoRegex = /^nano_[13][13456789abcdefghijkmnopqrstuwxyz]{59}$/;
  return nanoRegex.test(address);
}

function isValidAmount(amount) {
  if (amount === undefined || amount === null) return false;
  const num = parseFloat(amount);
  return !isNaN(num) && num > 0 && isFinite(num);
}

class NanoWalletManager {
  constructor(io) {
    this.io = io;
    this.wallets = this.loadWallets();
    this.gpuWorkerUrl = this.loadConfig().gpuWorkerUrl || null;
  }

  loadWallets() {
    try {
      if (fs.existsSync(WALLETS_FILE)) {
        const encryptedData = fs.readFileSync(WALLETS_FILE, 'utf8');
        const decrypted = decrypt(encryptedData);
        return JSON.parse(decrypted);
      }
    } catch (error) {
      console.error('Error loading wallets:', error.message);
    }
    return {};
  }

  saveWallets() {
    try {
      const dir = path.dirname(WALLETS_FILE);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      const encrypted = encrypt(JSON.stringify(this.wallets));
      fs.writeFileSync(WALLETS_FILE, encrypted);
    } catch (error) {
      console.error('Error saving wallets:', error.message);
    }
  }

  loadConfig() {
    try {
      if (fs.existsSync(CONFIG_FILE)) {
        const data = fs.readFileSync(CONFIG_FILE, 'utf8');
        return JSON.parse(data);
      }
    } catch (error) {
      console.error('Error loading config:', error.message);
    }
    return {};
  }

  saveConfig() {
    try {
      const dir = path.dirname(CONFIG_FILE);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      const config = {
        gpuWorkerUrl: this.gpuWorkerUrl
      };
      fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2));
    } catch (error) {
      console.error('Error saving config:', error.message);
    }
  }

  setGpuWorkerUrl(url) {
    this.gpuWorkerUrl = url;
    this.saveConfig();
    this.log('info', url ? 'GPU PoW worker configured and saved' : 'GPU PoW worker disabled');
  }

  log(level, message) {
    const entry = {
      timestamp: new Date().toISOString(),
      level,
      message: `[Nano] ${message}`,
      source: 'nano'
    };
    this.io.emit('nano-log', entry);
  }

  createWallet(name, type = 'hd') {
    try {
      if (!name || typeof name !== 'string' || name.length < 1 || name.length > 50) {
        throw new Error('Invalid wallet name');
      }
      if (this.wallets[name]) {
        throw new Error(`Wallet "${name}" already exists`);
      }

      let newWallet;
      if (type === 'hd') {
        newWallet = wallet.generate();
      } else {
        newWallet = wallet.generateLegacy();
      }

      const account = newWallet.accounts[0];
      
      const mnemonicForUser = newWallet.mnemonic || null;
      
      this.wallets[name] = {
        name,
        type,
        seed: newWallet.seed,
        accounts: [{
          index: 0,
          address: account.address,
          publicKey: account.publicKey,
          privateKey: account.privateKey
        }],
        createdAt: new Date().toISOString()
      };

      this.saveWallets();
      this.log('success', `Created new ${type} wallet: ${name}`);
      
      return {
        success: true,
        wallet: this.getWalletInfo(name),
        mnemonic: mnemonicForUser,
        address: account.address
      };
    } catch (error) {
      this.log('error', `Failed to create wallet: ${error.message}`);
      return { success: false, error: error.message };
    }
  }

  importWallet(name, seedOrMnemonic, type = 'hd') {
    try {
      if (!name || typeof name !== 'string' || name.length < 1 || name.length > 50) {
        throw new Error('Invalid wallet name');
      }
      if (!seedOrMnemonic || typeof seedOrMnemonic !== 'string') {
        throw new Error('Invalid seed or mnemonic');
      }
      if (this.wallets[name]) {
        throw new Error(`Wallet "${name}" already exists`);
      }

      let importedWallet;
      const isMnemonic = seedOrMnemonic.includes(' ');

      if (isMnemonic) {
        if (type === 'hd') {
          importedWallet = wallet.fromMnemonic(seedOrMnemonic);
        } else {
          importedWallet = wallet.fromLegacyMnemonic(seedOrMnemonic);
        }
      } else {
        importedWallet = wallet.fromSeed(seedOrMnemonic);
      }

      const account = importedWallet.accounts[0];

      this.wallets[name] = {
        name,
        type,
        seed: importedWallet.seed,
        accounts: [{
          index: 0,
          address: account.address,
          publicKey: account.publicKey,
          privateKey: account.privateKey
        }],
        createdAt: new Date().toISOString()
      };

      this.saveWallets();
      this.log('success', `Imported wallet: ${name}`);

      return {
        success: true,
        wallet: this.getWalletInfo(name)
      };
    } catch (error) {
      this.log('error', `Failed to import wallet: ${error.message}`);
      return { success: false, error: error.message };
    }
  }

  deleteWallet(name) {
    try {
      if (!this.wallets[name]) {
        throw new Error(`Wallet "${name}" not found`);
      }

      delete this.wallets[name];
      this.saveWallets();
      this.log('info', `Deleted wallet: ${name}`);

      return { success: true };
    } catch (error) {
      this.log('error', `Failed to delete wallet: ${error.message}`);
      return { success: false, error: error.message };
    }
  }

  getWalletInfo(name) {
    const w = this.wallets[name];
    if (!w) return null;

    return {
      name: w.name,
      type: w.type,
      address: w.accounts[0].address,
      createdAt: w.createdAt,
      accountCount: w.accounts.length
    };
  }

  getWalletPublicDetails(name) {
    const w = this.wallets[name];
    if (!w) return null;

    return {
      name: w.name,
      type: w.type,
      accounts: w.accounts.map(acc => ({
        index: acc.index,
        address: acc.address
      })),
      createdAt: w.createdAt
    };
  }

  getWalletBackup(name, password) {
    try {
      const w = this.wallets[name];
      if (!w) {
        return { success: false, error: 'Wallet not found' };
      }

      if (!password || password.length < 4) {
        return { success: false, error: 'Password must be at least 4 characters' };
      }

      const expectedPassword = w.name.toLowerCase().replace(/\s+/g, '');
      if (password.toLowerCase() !== expectedPassword) {
        return { success: false, error: 'Invalid password. Hint: Use your wallet name (lowercase, no spaces)' };
      }

      this.log('warning', `Backup requested for wallet: ${name}`);

      if (w.type === 'hd' && w.mnemonic) {
        return {
          success: true,
          type: 'hd',
          mnemonic: w.mnemonic
        };
      } else if (w.seed) {
        return {
          success: true,
          type: 'legacy',
          seed: w.seed
        };
      } else {
        return { success: false, error: 'No backup data available for this wallet' };
      }
    } catch (error) {
      return { success: false, error: error.message };
    }
  }

  listWallets() {
    return Object.keys(this.wallets).map(name => this.getWalletInfo(name));
  }

  async getAccountInfo(address) {
    try {
      if (!isValidNanoAddress(address)) {
        throw new Error('Invalid Nano address');
      }

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

      if (!response.ok) {
        throw new Error(`RPC request failed with status ${response.status}`);
      }

      const data = await response.json();
      
      if (data.error === 'Account not found') {
        return {
          opened: false,
          balance: '0',
          pending: '0',
          frontier: '0000000000000000000000000000000000000000000000000000000000000000'
        };
      }

      if (data.error) {
        throw new Error(data.error);
      }

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
    } catch (error) {
      this.log('error', `Failed to get account info: ${error.message}`);
      throw error;
    }
  }

  async getPendingBlocks(address) {
    try {
      if (!isValidNanoAddress(address)) {
        throw new Error('Invalid Nano address');
      }

      const response = await fetch(RPC_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'pending',
          account: address,
          count: 10,
          source: true,
          include_only_confirmed: true
        })
      });

      if (!response.ok) {
        throw new Error(`RPC request failed with status ${response.status}`);
      }

      const data = await response.json();
      
      if (data.error) {
        if (data.error === 'Account not found') {
          return [];
        }
        throw new Error(data.error);
      }

      const blocks = data.blocks || {};
      return Object.entries(blocks).map(([hash, info]) => ({
        hash,
        amount: info.amount,
        amountNano: tools.convert(info.amount, 'RAW', 'NANO'),
        source: info.source
      }));
    } catch (error) {
      this.log('error', `Failed to get pending blocks: ${error.message}`);
      throw error;
    }
  }

  async generateWork(hash) {
    if (this.gpuWorkerUrl) {
      try {
        const response = await fetch(this.gpuWorkerUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            action: 'work_generate',
            hash: hash,
            difficulty: 'fffffff800000000'
          })
        });

        const data = await response.json();
        if (data.work) {
          this.log('info', 'PoW generated via GPU worker');
          return data.work;
        }
      } catch (error) {
        this.log('warning', 'GPU worker unavailable, using RPC');
      }
    }

    const response = await fetch(POW_RPC_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        action: 'work_generate',
        hash: hash,
        difficulty: 'fffffff800000000'
      })
    });

    if (!response.ok) {
      throw new Error(`Work generation RPC failed with status ${response.status}`);
    }

    const data = await response.json();
    if (data.error) {
      throw new Error(`Work generation failed: ${data.error}`);
    }

    return data.work;
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

    if (!response.ok) {
      throw new Error(`Process block RPC failed with status ${response.status}`);
    }

    const data = await response.json();
    if (data.error) {
      throw new Error(data.error);
    }

    return data.hash;
  }

  async sendNano(walletName, toAddress, amountNano) {
    try {
      if (!isValidNanoAddress(toAddress)) {
        throw new Error('Invalid recipient Nano address');
      }
      if (!isValidAmount(amountNano)) {
        throw new Error('Invalid amount');
      }

      const w = this.wallets[walletName];
      if (!w) {
        throw new Error(`Wallet "${walletName}" not found`);
      }

      const account = w.accounts[0];
      const fromAddress = account.address;
      
      this.log('info', `Preparing to send ${amountNano} NANO`);

      const accountInfo = await this.getAccountInfo(fromAddress);
      if (!accountInfo.opened) {
        throw new Error('Account has not been opened yet (no incoming transactions)');
      }

      const amountRaw = tools.convert(amountNano, 'NANO', 'RAW');
      
      if (BigInt(amountRaw) > BigInt(accountInfo.balance)) {
        throw new Error('Insufficient balance');
      }

      this.log('info', 'Generating proof of work...');
      const work = await this.generateWork(accountInfo.frontier);

      const sendBlockData = block.send({
        walletBalanceRaw: accountInfo.balance,
        fromAddress: fromAddress,
        toAddress: toAddress,
        representativeAddress: accountInfo.representative,
        frontier: accountInfo.frontier,
        amountRaw: amountRaw,
        work: work
      }, account.privateKey);

      this.log('info', 'Broadcasting transaction...');
      const hash = await this.processBlock(sendBlockData);

      this.log('success', `Transaction sent successfully`);

      return {
        success: true,
        hash: hash,
        amount: amountNano
      };
    } catch (error) {
      this.log('error', `Send failed: ${error.message}`);
      return { success: false, error: error.message };
    }
  }

  async receiveNano(walletName, blockHash = null) {
    try {
      const w = this.wallets[walletName];
      if (!w) {
        throw new Error(`Wallet "${walletName}" not found`);
      }

      const account = w.accounts[0];
      const address = account.address;

      if (!blockHash) {
        const pendingBlocks = await this.getPendingBlocks(address);
        if (pendingBlocks.length === 0) {
          this.log('info', 'No pending transactions to receive');
          return { success: true, received: 0, transactions: [] };
        }

        const results = [];
        for (const pending of pendingBlocks) {
          const result = await this.receiveSingleBlock(w, pending.hash, pending.amount);
          results.push(result);
        }

        return {
          success: true,
          received: results.length,
          transactions: results
        };
      }

      const pending = await this.getPendingBlocks(address);
      const targetBlock = pending.find(p => p.hash === blockHash);
      
      if (!targetBlock) {
        throw new Error('Pending block not found');
      }

      const result = await this.receiveSingleBlock(w, blockHash, targetBlock.amount);

      return {
        success: true,
        received: 1,
        transactions: [result]
      };
    } catch (error) {
      this.log('error', `Receive failed: ${error.message}`);
      return { success: false, error: error.message };
    }
  }

  async receiveSingleBlock(walletData, pendingHash, amountRaw) {
    const account = walletData.accounts[0];
    const address = account.address;
    
    const accountInfo = await this.getAccountInfo(address);
    
    const representative = accountInfo.representative || 
      'nano_3kc8wwut3u8g1kwa6x4drkzu346bdbyqzsn14tmabrpeobn8igksfqkzajbb';

    const workHash = accountInfo.opened ? accountInfo.frontier : account.publicKey;
    
    this.log('info', 'Generating proof of work for receive...');
    const work = await this.generateWork(workHash);

    const receiveBlockData = block.receive({
      walletBalanceRaw: accountInfo.balance,
      toAddress: address,
      representativeAddress: representative,
      frontier: accountInfo.frontier,
      transactionHash: pendingHash,
      amountRaw: amountRaw,
      work: work
    }, account.privateKey);

    this.log('info', 'Broadcasting receive block...');
    const hash = await this.processBlock(receiveBlockData);

    const amountNano = tools.convert(amountRaw, 'RAW', 'NANO');
    this.log('success', `Received ${amountNano} NANO`);

    return {
      hash: hash,
      amount: amountNano,
      pendingHash: pendingHash
    };
  }

  async syncWallet(walletName) {
    try {
      const w = this.wallets[walletName];
      if (!w) {
        throw new Error(`Wallet "${walletName}" not found`);
      }

      const address = w.accounts[0].address;
      
      this.log('info', `Syncing wallet: ${walletName}`);
      
      const accountInfo = await this.getAccountInfo(address);
      const pendingBlocks = await this.getPendingBlocks(address);

      return {
        success: true,
        wallet: walletName,
        address: address,
        balance: accountInfo.balanceNano || '0',
        balanceRaw: accountInfo.balance,
        pending: accountInfo.pendingNano || '0',
        pendingRaw: accountInfo.pending,
        opened: accountInfo.opened,
        blockCount: accountInfo.blockCount || 0,
        pendingBlocks: pendingBlocks
      };
    } catch (error) {
      this.log('error', `Sync failed: ${error.message}`);
      return { success: false, error: error.message };
    }
  }

  deriveNewAccount(walletName) {
    try {
      const w = this.wallets[walletName];
      if (!w) {
        throw new Error(`Wallet "${walletName}" not found`);
      }

      const nextIndex = w.accounts.length;
      const accounts = wallet.accounts(w.seed, nextIndex, nextIndex);
      const newAccount = accounts[0];

      w.accounts.push({
        index: nextIndex,
        address: newAccount.address,
        publicKey: newAccount.publicKey,
        privateKey: newAccount.privateKey
      });

      this.saveWallets();
      this.log('success', `Derived new account #${nextIndex}`);

      return {
        success: true,
        account: {
          index: nextIndex,
          address: newAccount.address
        }
      };
    } catch (error) {
      this.log('error', `Failed to derive account: ${error.message}`);
      return { success: false, error: error.message };
    }
  }

  convertUnits(amount, from, to) {
    try {
      const result = tools.convert(amount, from, to);
      return { success: true, result };
    } catch (error) {
      return { success: false, error: error.message };
    }
  }
}

module.exports = { NanoWalletManager, isValidNanoAddress, isValidAmount };
