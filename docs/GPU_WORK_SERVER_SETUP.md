# Nano GPU Work Server Setup Guide

This guide explains how to set up a dedicated GPU-powered Proof-of-Work (PoW) server for Nano cryptocurrency transactions. This server will generate PoW extremely fast using GPU acceleration, making transactions near-instant.

## Overview

**What is nano-work-server?**
- A dedicated PoW generation server for Nano cryptocurrency
- Uses GPU (via OpenCL) for extremely fast work generation
- Exposes HTTP JSON-RPC API compatible with Nano RPC commands
- Much faster than CPU-based work generation

**Why use it?**
- Free RPC services are slow and may have rate limits
- GPU work generation is 10-100x faster than CPU
- Full control over your infrastructure
- No dependency on third-party services

---

## Requirements

### Hardware
- Ubuntu Linux VM (20.04 LTS or newer recommended)
- NVIDIA GPU with CUDA support (GTX 1060 or better recommended)
- At least 4GB RAM
- 50GB+ storage (for ledger snapshot)

### Software
- Ubuntu 20.04/22.04/24.04 LTS
- NVIDIA drivers with CUDA support
- Rust toolchain
- OpenCL libraries

---

## Step 1: System Preparation

```bash
# Update system
sudo apt update && sudo apt upgrade -y

# Install essential build tools
sudo apt install -y build-essential git curl wget p7zip-full

# Install OpenCL dependencies
sudo apt install -y ocl-icd-opencl-dev gcc clinfo
```

---

## Step 2: Install NVIDIA Drivers and CUDA

```bash
# Remove any existing NVIDIA installations (optional, for clean install)
sudo apt remove --purge nvidia-* -y
sudo apt autoremove -y

# Add NVIDIA driver PPA
sudo add-apt-repository ppa:graphics-drivers/ppa -y
sudo apt update

# Install NVIDIA driver (check your GPU compatibility for version)
sudo apt install -y nvidia-driver-535

# Install CUDA toolkit
sudo apt install -y nvidia-cuda-toolkit

# Reboot to load drivers
sudo reboot
```

### After Reboot - Verify Installation

```bash
# Check NVIDIA driver
nvidia-smi

# Check CUDA version
nvcc --version

# Verify OpenCL sees your GPU
clinfo | grep -i nvidia
```

**Expected output from `nvidia-smi`:** Should show your GPU model, driver version, and CUDA version.

---

## Step 3: Install Rust

```bash
# Install Rust via rustup
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y

# Load Rust environment
source $HOME/.cargo/env

# Verify installation
rustc --version
cargo --version
```

---

## Step 4: Build nano-work-server

```bash
# Clone the repository
git clone https://github.com/nanocurrency/nano-work-server.git
cd nano-work-server

# Build release version (optimized)
cargo build --release

# The binary will be at: ./target/release/nano-work-server
```

### If OpenCL library not found:

```bash
# Find OpenCL library location
find /usr -name "libOpenCL*" 2>/dev/null

# Build with explicit library path
cargo rustc --release -- -l OpenCL -L "/usr/lib/x86_64-linux-gnu/"
```

---

## Step 5: Identify Your GPU

```bash
# List all OpenCL devices
clinfo

# Or use the work server to show devices
./target/release/nano-work-server --help
```

**Note the Platform and Device numbers.** Usually:
- Platform 0 = NVIDIA
- Device 0 = Your first GPU

---

## Step 6: Run nano-work-server

### Basic Usage

```bash
# Run with GPU (Platform 0, Device 0)
./target/release/nano-work-server --gpu 0:0

# Run on specific port (default is 7076)
./target/release/nano-work-server --gpu 0:0 --listen-address 0.0.0.0:7076

# Run with custom thread count (optional)
./target/release/nano-work-server --gpu 0:0:1048576
```

### Test the Server

```bash
# In another terminal, test work generation
curl -X POST http://localhost:7076 \
  -H "Content-Type: application/json" \
  -d '{
    "action": "work_generate",
    "hash": "0000000000000000000000000000000000000000000000000000000000000000",
    "difficulty": "fffffff800000000"
  }'
```

**Expected response:**
```json
{
  "work": "abc123...",
  "difficulty": "fffffff800000000",
  "multiplier": "1.0"
}
```

---

## Step 7: Create Systemd Service (Auto-start)

```bash
sudo nano /etc/systemd/system/nano-work-server.service
```

**Paste this content:**

```ini
[Unit]
Description=Nano GPU Work Server
After=network.target

[Service]
Type=simple
User=YOUR_USERNAME
WorkingDirectory=/home/YOUR_USERNAME/nano-work-server
ExecStart=/home/YOUR_USERNAME/nano-work-server/target/release/nano-work-server --gpu 0:0 --listen-address 0.0.0.0:7076
Restart=always
RestartSec=10

[Install]
WantedBy=multi-user.target
```

**Replace `YOUR_USERNAME` with your actual username.**

```bash
# Enable and start the service
sudo systemctl daemon-reload
sudo systemctl enable nano-work-server
sudo systemctl start nano-work-server

# Check status
sudo systemctl status nano-work-server

# View logs
sudo journalctl -u nano-work-server -f
```

---

## Step 8: Configure Firewall

```bash
# Allow port 7076 for work server API
sudo ufw allow 7076/tcp

# If using different port, adjust accordingly
```

---

## Step 9: (Optional) Download Ledger Snapshot for Faster Sync

If you also want to run a full Nano node (not required for work-server only):

```bash
# Download the official snapshot
wget https://s3.us-east-2.amazonaws.com/repo.nano.org/snapshots/Nano_64_2025_12_10_23.7z

# Extract (requires p7zip)
7z x Nano_64_2025_12_10_23.7z

# Move to Nano data directory
mkdir -p ~/Nano
mv data.ldb ~/Nano/
```

**Note:** The nano-work-server does NOT require a full node or ledger. It only generates PoW. The snapshot is only needed if you want to run your own Nano node.

---

## API Reference

### work_generate
Generate PoW for a block hash.

```json
POST http://YOUR_SERVER_IP:7076

{
  "action": "work_generate",
  "hash": "BLOCK_FRONTIER_OR_PUBLIC_KEY",
  "difficulty": "fffffff800000000"
}
```

**Response:**
```json
{
  "work": "abc123def456...",
  "difficulty": "fffffff800000000",
  "multiplier": "1.0"
}
```

### work_validate
Validate if work meets difficulty threshold.

```json
{
  "action": "work_validate",
  "hash": "BLOCK_HASH",
  "work": "WORK_VALUE",
  "difficulty": "fffffff800000000"
}
```

### work_cancel
Cancel an in-progress work request.

```json
{
  "action": "work_cancel",
  "hash": "BLOCK_HASH"
}
```

---

## Integration with This Project

Once your GPU work server is running, configure it in the dashboard:

1. Go to the **CryptoVault** tab
2. Click **Settings** (gear icon)
3. Enter your GPU Worker URL: `http://YOUR_SERVER_IP:7076`
4. Click **Save**

The project will now use your GPU server for fast PoW generation. If the GPU server is unavailable, it will fall back to free public RPC.

---

## Troubleshooting

### GPU Not Detected

```bash
# Check if NVIDIA driver is loaded
lsmod | grep nvidia

# Check OpenCL devices
clinfo

# Reinstall CUDA toolkit if needed
sudo apt install --reinstall nvidia-cuda-toolkit
```

### "Failed to create GPU from string" Error

This usually means OpenCL can't access your GPU:

```bash
# Ensure nvidia-opencl-icd is installed
sudo apt install nvidia-opencl-icd-340 # or appropriate version

# Create ICD file manually if needed
sudo mkdir -p /etc/OpenCL/vendors
echo "libnvidia-opencl.so.1" | sudo tee /etc/OpenCL/vendors/nvidia.icd
```

### Permission Denied

```bash
# Add user to video group
sudo usermod -a -G video $USER

# Log out and back in
```

### Low Performance

- Ensure GPU is not throttling (check `nvidia-smi` for temperature)
- Increase thread count: `--gpu 0:0:2097152`
- Ensure no other processes are using the GPU

---

## Security Recommendations

1. **Firewall**: Only allow connections from your Replit app's IP
2. **VPN**: Consider using a VPN or private network
3. **HTTPS**: Use a reverse proxy (nginx) with SSL for production
4. **Rate Limiting**: Implement rate limiting to prevent abuse

---

## Performance Expectations

| GPU Model | Work Generation Time |
|-----------|---------------------|
| GTX 1060 | ~50-100ms |
| GTX 1080 Ti | ~20-40ms |
| RTX 3070 | ~10-30ms |
| RTX 3090 | ~5-15ms |
| RTX 4090 | ~3-10ms |

Compared to CPU: 5-30 seconds
Compared to free RPC: 1-5 seconds (plus network latency)

---

## Summary

1. Install NVIDIA drivers + CUDA
2. Install Rust
3. Build nano-work-server
4. Run with `--gpu 0:0` flag
5. Create systemd service for auto-start
6. Configure firewall
7. Enter server URL in dashboard settings

Your GPU work server is now ready to provide ultra-fast PoW for Nano transactions!
