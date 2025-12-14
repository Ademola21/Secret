const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const { AutomationEngine } = require('./engine');
const { NanoWalletManager, isValidNanoAddress, isValidAmount } = require('./nano-wallet');
const { FaucetSentry } = require('./faucet-sentry');
const { MultiInstanceManager } = require('./multi-instance-manager');
const { stateManager } = require('./state-manager');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: '*',
    methods: ['GET', 'POST']
  }
});

app.use(express.json());
app.use(express.static(path.join(__dirname, '../public')));

const engine = new AutomationEngine(io);
const nanoWallet = new NanoWalletManager(io);
const faucetSentry = new FaucetSentry(io, nanoWallet);
const multiInstance = new MultiInstanceManager(io, nanoWallet);

app.get('/api/status', (req, res) => {
  res.json({
    status: engine.getStatus(),
    activeTasks: engine.getActiveTasks(),
    logs: engine.getLogs(50)
  });
});

app.post('/api/task/start', async (req, res) => {
  try {
    const { taskType, options } = req.body;
    const taskId = await engine.startTask(taskType, options);
    res.json({ success: true, taskId });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.post('/api/task/stop', async (req, res) => {
  try {
    const { taskId } = req.body;
    await engine.stopTask(taskId);
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.post('/api/task/stopall', async (req, res) => {
  try {
    await engine.stopAllTasks();
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.get('/api/logs', (req, res) => {
  const limit = parseInt(req.query.limit) || 100;
  res.json(engine.getLogs(limit));
});

app.delete('/api/logs', (req, res) => {
  engine.clearLogs();
  res.json({ success: true });
});

app.delete('/api/faucet/logs', (req, res) => {
  faucetSentry.clearLogs();
  res.json({ success: true });
});

app.get('/api/tasks', (req, res) => {
  res.json(engine.getTaskTypes());
});

app.get('/api/nano/wallets', (req, res) => {
  res.json({ success: true, wallets: nanoWallet.listWallets() });
});

app.post('/api/nano/wallet/create', (req, res) => {
  const { name, type } = req.body;
  if (!name) {
    return res.status(400).json({ success: false, error: 'Wallet name is required' });
  }
  const result = nanoWallet.createWallet(name, type || 'hd');
  res.json(result);
});

app.post('/api/nano/wallet/import', (req, res) => {
  const { name, seedOrMnemonic, type } = req.body;
  if (!name || !seedOrMnemonic) {
    return res.status(400).json({ success: false, error: 'Name and seed/mnemonic are required' });
  }
  const result = nanoWallet.importWallet(name, seedOrMnemonic, type || 'hd');
  res.json(result);
});

app.delete('/api/nano/wallet/:name', (req, res) => {
  const { name } = req.params;
  const result = nanoWallet.deleteWallet(name);
  res.json(result);
});

app.get('/api/nano/wallet/:name', (req, res) => {
  const { name } = req.params;
  const details = nanoWallet.getWalletPublicDetails(name);
  if (!details) {
    return res.status(404).json({ success: false, error: 'Wallet not found' });
  }
  res.json({ success: true, wallet: details });
});

app.get('/api/nano/wallet/:name/sync', async (req, res) => {
  const { name } = req.params;
  const result = await nanoWallet.syncWallet(name);
  res.json(result);
});

app.post('/api/nano/wallet/:name/send', async (req, res) => {
  const { name } = req.params;
  const { to, amount } = req.body;
  if (!to || !amount) {
    return res.status(400).json({ success: false, error: 'Recipient address and amount are required' });
  }
  if (!isValidNanoAddress(to)) {
    return res.status(400).json({ success: false, error: 'Invalid Nano address format' });
  }
  if (!isValidAmount(amount)) {
    return res.status(400).json({ success: false, error: 'Invalid amount' });
  }
  const result = await nanoWallet.sendNano(name, to, amount);
  res.json(result);
});

app.post('/api/nano/wallet/:name/receive', async (req, res) => {
  const { name } = req.params;
  const { blockHash } = req.body;
  const result = await nanoWallet.receiveNano(name, blockHash);
  res.json(result);
});

app.post('/api/nano/wallet/:name/derive', (req, res) => {
  const { name } = req.params;
  const result = nanoWallet.deriveNewAccount(name);
  res.json(result);
});

app.post('/api/nano/wallet/:name/backup', (req, res) => {
  const { name } = req.params;
  const { password } = req.body;
  if (!password) {
    return res.status(400).json({ success: false, error: 'Password is required' });
  }
  const result = nanoWallet.getWalletBackup(name, password);
  res.json(result);
});

app.post('/api/nano/gpu-worker', async (req, res) => {
  const { url } = req.body;
  
  if (!url) {
    nanoWallet.setGpuWorkerUrl(null);
    return res.json({ success: true, message: 'GPU worker disabled, using public RPC' });
  }
  
  try {
    const testResponse = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        action: 'work_generate',
        hash: '0000000000000000000000000000000000000000000000000000000000000000',
        difficulty: 'fffffff800000000'
      }),
      signal: AbortSignal.timeout(10000)
    });
    
    if (!testResponse.ok) {
      return res.json({ success: false, error: `GPU worker returned status ${testResponse.status}` });
    }
    
    const testData = await testResponse.json();
    if (testData.error) {
      return res.json({ success: false, error: `GPU worker error: ${testData.error}` });
    }
    
    if (!testData.work) {
      return res.json({ success: false, error: 'GPU worker did not return valid work' });
    }
    
    nanoWallet.setGpuWorkerUrl(url);
    res.json({ success: true, message: 'GPU worker configured and tested successfully' });
  } catch (error) {
    res.json({ success: false, error: `Cannot connect to GPU worker: ${error.message}` });
  }
});

app.get('/api/nano/gpu-worker', (req, res) => {
  res.json({ 
    success: true, 
    url: nanoWallet.gpuWorkerUrl || null,
    active: !!nanoWallet.gpuWorkerUrl 
  });
});

app.post('/api/nano/convert', (req, res) => {
  const { amount, from, to } = req.body;
  const result = nanoWallet.convertUnits(amount, from, to);
  res.json(result);
});

app.get('/api/nano/network-status', async (req, res) => {
  try {
    const response = await fetch('https://node.somenano.com/proxy', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'block_count' }),
      signal: AbortSignal.timeout(5000)
    });
    
    if (response.ok) {
      const data = await response.json();
      res.json({ connected: true, blockCount: data.count });
    } else {
      res.json({ connected: false });
    }
  } catch (error) {
    res.json({ connected: false });
  }
});

app.get('/api/faucet/status', (req, res) => {
  res.json(faucetSentry.getStatus());
});

app.get('/api/faucet/logs', (req, res) => {
  const limit = parseInt(req.query.limit) || 100;
  res.json(faucetSentry.getLogs(limit));
});

app.post('/api/faucet/bank-wallet', async (req, res) => {
  const { walletName } = req.body;
  const result = await faucetSentry.setBankWallet(walletName);
  res.json(result);
});

app.get('/api/faucet/bank-balance', async (req, res) => {
  const result = await faucetSentry.getBankWalletBalance();
  res.json(result);
});

app.post('/api/faucet/connection', (req, res) => {
  const { type, proxyUrl } = req.body;
  const result = faucetSentry.setConnectionType(type, proxyUrl);
  res.json(result);
});

app.post('/api/faucet/start', async (req, res) => {
  const result = await faucetSentry.startClaimSession();
  res.json(result);
});

app.post('/api/faucet/stop', async (req, res) => {
  const result = await faucetSentry.stopSession();
  res.json(result);
});

app.post('/api/faucet/pause', (req, res) => {
  const result = faucetSentry.pauseSession();
  res.json(result);
});

app.post('/api/faucet/auto-restart', (req, res) => {
  const { enabled } = req.body;
  const result = faucetSentry.setAutoRestart(enabled !== false);
  res.json(result);
});

app.post('/api/faucet/multi/start', async (req, res) => {
  const { instanceCount } = req.body;
  const config = faucetSentry.config;
  const result = await multiInstance.startInstances(instanceCount || 1, config);
  res.json(result);
});

app.post('/api/faucet/multi/stop', async (req, res) => {
  const result = await multiInstance.stopAllInstances();
  res.json(result);
});

app.get('/api/faucet/multi/status', (req, res) => {
  res.json(multiInstance.getStatus());
});

app.post('/api/faucet/multi/stop/:instanceId', async (req, res) => {
  const { instanceId } = req.params;
  const result = await multiInstance.stopInstance(instanceId);
  res.json(result);
});

app.get('/api/rpc/test', async (req, res) => {
  const results = {
    nanoNode: { url: 'http://157.230.168.241:7076', status: 'unknown', latency: null },
    powRpcs: []
  };
  
  const powUrls = [
    'https://rainstorm.city/api',
    'https://node.somenano.com/proxy',
    'https://proxy.nanos.cc/proxy'
  ];
  
  const testRpc = async (url, testAction) => {
    const start = Date.now();
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(testAction),
        signal: AbortSignal.timeout(10000)
      });
      const latency = Date.now() - start;
      if (response.ok) {
        const data = await response.json();
        if (data.error) {
          return { status: 'error', error: data.error, latency };
        }
        return { status: 'ok', latency, data };
      }
      return { status: 'error', error: `HTTP ${response.status}`, latency };
    } catch (error) {
      return { status: 'error', error: error.message, latency: Date.now() - start };
    }
  };
  
  const nanoNodeResult = await testRpc(results.nanoNode.url, { action: 'block_count' });
  results.nanoNode.status = nanoNodeResult.status;
  results.nanoNode.latency = nanoNodeResult.latency;
  results.nanoNode.error = nanoNodeResult.error;
  if (nanoNodeResult.data) {
    results.nanoNode.blockCount = nanoNodeResult.data.count;
  }
  
  for (const url of powUrls) {
    const powResult = await testRpc(url, { 
      action: 'work_generate', 
      hash: '0000000000000000000000000000000000000000000000000000000000000000',
      difficulty: 'fffffff800000000'
    });
    results.powRpcs.push({
      url,
      status: powResult.status,
      latency: powResult.latency,
      error: powResult.error,
      hasWork: !!(powResult.data && powResult.data.work)
    });
  }
  
  res.json({ success: true, results });
});

io.on('connection', (socket) => {
  engine.log('info', 'Dashboard client connected');
  
  socket.emit('status', {
    status: engine.getStatus(),
    activeTasks: engine.getActiveTasks(),
    logs: engine.getLogs(200)
  });

  socket.emit('nano-wallets', {
    wallets: nanoWallet.listWallets()
  });

  socket.emit('faucet-status', faucetSentry.getStatus());
  
  socket.emit('faucet-logs', {
    logs: faucetSentry.getLogs(200)
  });
  
  socket.emit('multi-instance-status', multiInstance.getStatus());
  
  const lastScreenshot = stateManager.getLastScreenshot();
  if (lastScreenshot) {
    socket.emit('screenshot', lastScreenshot);
  }
  
  const faucetScreenshot = stateManager.getFaucetScreenshot();
  if (faucetScreenshot) {
    socket.emit('faucet-screenshot', faucetScreenshot);
  }

  socket.on('disconnect', () => {
    engine.log('info', 'Dashboard client disconnected');
  });
});

const PORT = process.env.PORT || 5000;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`Automation Dashboard running on http://0.0.0.0:${PORT}`);
  engine.log('success', `Server started on port ${PORT}`);
});
