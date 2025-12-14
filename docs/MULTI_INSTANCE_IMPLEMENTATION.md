# Multi-Instance Claim Feature Implementation Guide

This document explains how to implement parallel claim instances (1-10 simultaneous Chrome browsers) for the FaucetSentry module.

---

## Overview

The multi-instance feature allows running multiple Chrome browser sessions simultaneously, each with its own unique IP address (via Tor circuits or proxy pool). This increases claim throughput significantly.

**Example:** With 10 instances, you can potentially complete 10 claims in the time it normally takes for 1 claim.

---

## Architecture Changes Required

### 1. Tor Multi-Circuit Setup

Instead of using a single Tor SOCKS port (9050), you need multiple independent Tor circuits. Each instance gets its own Tor port.

**Tor Configuration (`/etc/tor/torrc` or custom config):**

```
# Instance 1
SocksPort 9050
ControlPort 9051

# Instance 2  
SocksPort 9052
ControlPort 9053

# Instance 3
SocksPort 9054
ControlPort 9055

# Instance 4
SocksPort 9056
ControlPort 9057

# Instance 5
SocksPort 9058
ControlPort 9059

# Instance 6
SocksPort 9060
ControlPort 9061

# Instance 7
SocksPort 9062
ControlPort 9063

# Instance 8
SocksPort 9064
ControlPort 9065

# Instance 9
SocksPort 9066
ControlPort 9067

# Instance 10
SocksPort 9068
ControlPort 9069

DataDirectory /tmp/tor
Log notice stdout
```

**Alternative: Run Multiple Tor Processes**

For better isolation, run separate Tor processes:

```bash
# Create directories for each instance
mkdir -p /tmp/tor{1..10}

# Start each Tor instance
tor --SocksPort 9050 --ControlPort 9051 --DataDirectory /tmp/tor1 &
tor --SocksPort 9052 --ControlPort 9053 --DataDirectory /tmp/tor2 &
tor --SocksPort 9054 --ControlPort 9055 --DataDirectory /tmp/tor3 &
# ... and so on
```

---

### 2. Proxy Pool Alternative

If using proxies instead of Tor, you need a pool of at least 10 unique proxy IPs:

```javascript
const PROXY_POOL = [
  'http://user:pass@proxy1.example.com:8080',
  'http://user:pass@proxy2.example.com:8080',
  'http://user:pass@proxy3.example.com:8080',
  // ... up to 10 proxies
];
```

**Requirements:**
- Each proxy must have a different exit IP
- Rotating proxies work but may cause issues if IP changes mid-claim
- Residential proxies are recommended for best success rate

---

## Code Implementation

### 3. New Files to Create

**`server/multi-instance-manager.js`**

```javascript
const { FaucetSentry } = require('./faucet-sentry');

class MultiInstanceManager {
  constructor(io, nanoWallet) {
    this.io = io;
    this.nanoWallet = nanoWallet;
    this.instances = new Map(); // instanceId -> FaucetSentry
    this.maxInstances = 10;
    this.activeCount = 0;
    
    // Tor port mapping (instance index -> socks port)
    this.torPorts = [9050, 9052, 9054, 9056, 9058, 9060, 9062, 9064, 9066, 9068];
    this.controlPorts = [9051, 9053, 9055, 9057, 9059, 9061, 9063, 9065, 9067, 9069];
  }
  
  async startInstances(count, config) {
    if (count < 1 || count > this.maxInstances) {
      return { success: false, error: `Count must be between 1 and ${this.maxInstances}` };
    }
    
    const startedInstances = [];
    
    for (let i = 0; i < count; i++) {
      const instanceId = `instance_${i + 1}`;
      
      // Create new FaucetSentry instance with unique Tor port
      const instance = new FaucetSentry(this.io, this.nanoWallet);
      
      // Override Tor port for this instance
      instance.torSocksPort = this.torPorts[i];
      instance.torControlPort = this.controlPorts[i];
      instance.instanceId = instanceId;
      
      // Copy config
      instance.config = { ...config };
      
      this.instances.set(instanceId, instance);
      startedInstances.push(instanceId);
    }
    
    // Start all instances in parallel
    const startPromises = startedInstances.map(id => {
      const instance = this.instances.get(id);
      return instance.startClaimSession();
    });
    
    await Promise.all(startPromises);
    
    this.activeCount = count;
    this.emitStatus();
    
    return { success: true, instances: startedInstances };
  }
  
  async stopAllInstances() {
    const stopPromises = [];
    
    for (const [id, instance] of this.instances) {
      stopPromises.push(instance.stopSession());
    }
    
    await Promise.all(stopPromises);
    this.instances.clear();
    this.activeCount = 0;
    this.emitStatus();
    
    return { success: true };
  }
  
  getStatus() {
    const instanceStatuses = [];
    for (const [id, instance] of this.instances) {
      instanceStatuses.push({
        id,
        status: instance.sessionStats.status,
        torPort: instance.torSocksPort,
        totalClaims: instance.sessionStats.totalClaims,
        totalRewards: instance.sessionStats.totalRewards
      });
    }
    
    return {
      activeCount: this.activeCount,
      maxInstances: this.maxInstances,
      instances: instanceStatuses
    };
  }
  
  emitStatus() {
    this.io.emit('multi-instance-status', this.getStatus());
  }
}

module.exports = { MultiInstanceManager };
```

### 4. Modify `faucet-sentry.js`

Add instance-specific Tor port support:

```javascript
// In the constructor, add:
this.torSocksPort = 9050;  // Default, can be overridden
this.torControlPort = 9051;
this.instanceId = 'default';

// In launchBrowser(), change the Tor proxy line:
if (this.config.connectionType === 'tor') {
  args.push(`--proxy-server=socks5://127.0.0.1:${this.torSocksPort}`);
  this.log('info', `Using Tor network on port ${this.torSocksPort}`);
}

// In requestNewTorIdentity(), use dynamic port:
client.connect(this.torControlPort, '127.0.0.1', () => {
  // ...
});
```

### 5. Add API Endpoints in `index.js`

```javascript
const { MultiInstanceManager } = require('./multi-instance-manager');
const multiInstance = new MultiInstanceManager(io, nanoWallet);

app.post('/api/faucet/multi/start', async (req, res) => {
  const { instanceCount } = req.body;
  const config = faucetSentry.config; // Use same config
  const result = await multiInstance.startInstances(instanceCount, config);
  res.json(result);
});

app.post('/api/faucet/multi/stop', async (req, res) => {
  const result = await multiInstance.stopAllInstances();
  res.json(result);
});

app.get('/api/faucet/multi/status', (req, res) => {
  res.json(multiInstance.getStatus());
});
```

### 6. Frontend UI Changes

Add instance count selector in the FaucetSentry section:

```html
<div class="config-row">
  <div class="config-label">Instances</div>
  <div class="config-value">
    <input type="range" id="instanceCount" min="1" max="10" value="1" />
    <span id="instanceCountDisplay">1</span>
  </div>
</div>

<button id="startMultiBtn">Start Multi-Instance</button>
<button id="stopMultiBtn">Stop All</button>

<div id="instanceGrid">
  <!-- Dynamic instance status cards -->
</div>
```

---

## VM Requirements

### Minimum Specifications by Instance Count

| Instances | CPU Cores | RAM    | Storage | Notes |
|-----------|-----------|--------|---------|-------|
| 1         | 2 cores   | 2 GB   | 20 GB   | Current setup |
| 2-3       | 2 cores   | 4 GB   | 25 GB   | Light usage |
| 4-5       | 4 cores   | 8 GB   | 30 GB   | Moderate |
| 6-8       | 6 cores   | 12 GB  | 40 GB   | Heavy |
| 9-10      | 8 cores   | 16 GB  | 50 GB   | Maximum |

### Resource Breakdown Per Instance

- **Chrome/Chromium**: ~300-500 MB RAM each
- **Tor Process**: ~50-100 MB RAM each
- **Node.js Worker**: ~50-100 MB RAM each
- **CPU**: Each browser uses ~0.5-1 core during active claiming

### Recommended VPS Providers

| Provider | Plan | Specs | Price/Month |
|----------|------|-------|-------------|
| DigitalOcean | CPU-Optimized | 8 vCPU, 16 GB RAM | ~$96 |
| Vultr | High Frequency | 8 vCPU, 32 GB RAM | ~$96 |
| Hetzner | CPX41 | 8 vCPU, 16 GB RAM | ~$30 |
| Contabo | VPS L | 8 cores, 30 GB RAM | ~$15 |

---

## Important Considerations

### 1. Bank Wallet Balance

With 10 instances claiming simultaneously, you need sufficient funds:
- Each claim requires ~0.001 NANO donation
- Recommended: 0.1 NANO minimum in bank wallet for 10 instances

### 2. Rate Limiting

The faucet may detect and block multiple claims from same IP ranges. Using Tor with different circuits helps, but:
- Tor exit nodes may be flagged
- Space out instance starts by 30-60 seconds
- Don't run maximum instances 24/7

### 3. Failure Handling

If one instance fails:
- It should auto-restart with new identity (already implemented)
- Other instances continue unaffected
- Monitor total success rate across all instances

### 4. Logging

Each instance should prefix logs with its ID:
```
[Instance 1] Navigating to faucet...
[Instance 2] Waiting for reward...
[Instance 3] Claim completed! Net reward: 0.001 NANO
```

---

## Implementation Steps

1. **Phase 1: Tor Multi-Circuit**
   - Set up multiple Tor SOCKS ports
   - Test each port works independently
   - Verify unique IPs per port

2. **Phase 2: Backend Changes**
   - Create `multi-instance-manager.js`
   - Modify `faucet-sentry.js` for dynamic ports
   - Add API endpoints

3. **Phase 3: Frontend UI**
   - Add instance count slider
   - Create instance status grid
   - Show per-instance logs and statistics

4. **Phase 4: Testing**
   - Start with 2 instances
   - Verify unique IPs
   - Check memory/CPU usage
   - Scale up gradually

---

## Quick Start Script (VM Setup)

```bash
#!/bin/bash
# multi-tor-setup.sh

echo "Setting up multi-Tor instances..."

# Install Tor if not present
apt-get update && apt-get install -y tor

# Stop default Tor service
systemctl stop tor

# Create directories
for i in {1..10}; do
  mkdir -p /tmp/tor$i
done

# Start 10 Tor instances
for i in {1..10}; do
  SOCKS_PORT=$((9048 + (i * 2)))
  CONTROL_PORT=$((9049 + (i * 2)))
  DATA_DIR="/tmp/tor$i"
  
  tor --SocksPort $SOCKS_PORT \
      --ControlPort $CONTROL_PORT \
      --DataDirectory $DATA_DIR \
      --Log "notice file /var/log/tor$i.log" \
      --RunAsDaemon 1
  
  echo "Started Tor instance $i on ports $SOCKS_PORT/$CONTROL_PORT"
done

echo "All Tor instances started!"
echo "Verify with: curl --socks5 127.0.0.1:9050 https://api.ipify.org"
```

---

## Summary

Implementing multi-instance claiming requires:
1. Multiple Tor circuits or proxy pool
2. Backend manager to coordinate instances
3. Per-instance configuration and logging
4. Adequate VM resources (8+ cores, 16+ GB RAM for 10 instances)
5. Sufficient bank wallet balance

Start with 2-3 instances to test stability before scaling up.
