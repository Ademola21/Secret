#!/bin/bash

echo "========================================================"
echo "   FaucetSentry - Ubuntu/Debian VM Auto-Setup Script"
echo "   Self-Healing & Auto-Fix Enabled"
echo "========================================================"
echo ""

set -e

if [ "$EUID" -ne 0 ]; then
    SUDO="sudo"
else
    SUDO=""
fi

detect_os() {
    if [ -f /etc/os-release ]; then
        . /etc/os-release
        echo "$ID"
    elif [ -f /etc/debian_version ]; then
        echo "debian"
    elif [ -f /etc/redhat-release ]; then
        echo "rhel"
    else
        echo "unknown"
    fi
}

check_port() {
    local port=$1
    echo "   Checking port $port..."
    local pids=""
    
    if command -v lsof &> /dev/null; then
        pids=$(lsof -t -i:$port 2>/dev/null || true)
    elif command -v ss &> /dev/null; then
        pids=$(ss -tlnp 2>/dev/null | grep ":$port " | grep -oP 'pid=\K[0-9]+' || true)
    fi
    
    if [ -n "$pids" ]; then
        echo "   [INFO] Port $port in use by PID(s): $pids"
    else
        echo "   [OK] Port $port is available"
    fi
}

kill_app_port() {
    local port=$1
    echo "   Checking port $port..."
    local pids=""
    
    if command -v lsof &> /dev/null; then
        pids=$(lsof -t -i:$port 2>/dev/null || true)
    fi
    
    if [ -n "$pids" ]; then
        echo "   [FIX] Port $port in use, freeing..."
        for pid in $pids; do
            $SUDO kill -9 $pid 2>/dev/null || true
        done
        sleep 1
        echo "   [OK] Port $port freed"
    fi
}

# Number of Tor instances to setup (for multi-instance claiming)
TOR_INSTANCE_COUNT=${TOR_INSTANCE_COUNT:-10}

fix_tor() {
    echo ""
    echo "[AUTO-FIX] Checking Tor service..."
    
    if ! command -v tor &> /dev/null; then
        echo "   [FIX] Tor not found, installing..."
        if [ "$OS" = "ubuntu" ] || [ "$OS" = "debian" ]; then
            $SUDO apt-get install -y tor
        elif [ "$OS" = "rhel" ] || [ "$OS" = "centos" ] || [ "$OS" = "fedora" ]; then
            $SUDO yum install -y tor || $SUDO dnf install -y tor
        fi
    fi
    
    # Stop all existing Tor processes before setup
    echo "   [INFO] Stopping existing Tor processes..."
    $SUDO systemctl stop tor 2>/dev/null || true
    pkill -9 -x tor 2>/dev/null || true
    sleep 2
    
    echo "   [OK] Tor is installed"
}

setup_multi_tor() {
    echo ""
    echo "[MULTI-TOR] Setting up $TOR_INSTANCE_COUNT Tor instances for multi-instance claiming..."
    
    # Stop any existing Tor processes
    $SUDO systemctl stop tor 2>/dev/null || true
    pkill -9 -x tor 2>/dev/null || true
    sleep 2
    
    # Create data directories for each Tor instance
    echo "   [INFO] Creating Tor data directories..."
    for i in $(seq 1 $TOR_INSTANCE_COUNT); do
        $SUDO mkdir -p /tmp/tor$i
        $SUDO chmod 700 /tmp/tor$i
    done
    
    # Port mapping: Instance 1 = 9050/9051, Instance 2 = 9052/9053, etc.
    echo "   [INFO] Starting $TOR_INSTANCE_COUNT Tor instances..."
    
    STARTED_COUNT=0
    for i in $(seq 1 $TOR_INSTANCE_COUNT); do
        SOCKS_PORT=$((9048 + (i * 2)))
        CONTROL_PORT=$((9049 + (i * 2)))
        DATA_DIR="/tmp/tor$i"
        LOG_FILE="/tmp/tor$i.log"
        
        echo "   Starting Tor instance $i on ports $SOCKS_PORT/$CONTROL_PORT..."
        
        # Start Tor instance as daemon
        $SUDO tor --SocksPort $SOCKS_PORT \
            --ControlPort $CONTROL_PORT \
            --DataDirectory $DATA_DIR \
            --CookieAuthentication 0 \
            --Log "notice file $LOG_FILE" \
            --RunAsDaemon 1 2>/dev/null
        
        if [ $? -eq 0 ]; then
            STARTED_COUNT=$((STARTED_COUNT + 1))
        else
            echo "   [WARNING] Failed to start Tor instance $i"
        fi
        
        # Small delay between starting instances
        sleep 1
    done
    
    echo "   [INFO] Waiting for Tor instances to establish circuits..."
    sleep 10
    
    # Verify all instances are running
    echo ""
    echo "   [VERIFY] Checking Tor instance status..."
    AVAILABLE_COUNT=0
    for i in $(seq 1 $TOR_INSTANCE_COUNT); do
        SOCKS_PORT=$((9048 + (i * 2)))
        CONTROL_PORT=$((9049 + (i * 2)))
        
        if nc -z 127.0.0.1 $SOCKS_PORT 2>/dev/null; then
            echo "   [OK] Instance $i: SOCKS=$SOCKS_PORT CONTROL=$CONTROL_PORT"
            AVAILABLE_COUNT=$((AVAILABLE_COUNT + 1))
        else
            echo "   [FAIL] Instance $i: Port $SOCKS_PORT not responding"
        fi
    done
    
    echo ""
    echo "   [SUMMARY] $AVAILABLE_COUNT of $TOR_INSTANCE_COUNT Tor instances running"
    
    if [ $AVAILABLE_COUNT -ge 2 ]; then
        echo "   [OK] Multi-instance claiming ready!"
    else
        echo "   [WARNING] Less than 2 Tor instances available"
        echo "   [TIP] Try running this script again or check /tmp/tor*.log for errors"
    fi
}

# Function to verify Tor instances are working with unique IPs
verify_tor_ips() {
    echo ""
    echo "[VERIFY-IPS] Testing Tor instances for unique IPs..."
    
    for i in 1 2 3; do
        SOCKS_PORT=$((9048 + (i * 2)))
        if nc -z 127.0.0.1 $SOCKS_PORT 2>/dev/null; then
            IP=$(curl -s --socks5 127.0.0.1:$SOCKS_PORT https://api.ipify.org 2>/dev/null || echo "Failed")
            echo "   Instance $i (port $SOCKS_PORT): $IP"
        fi
    done
    echo "   (Only showing first 3 instances)"
}

fix_xvfb() {
    echo ""
    echo "[AUTO-FIX] Checking Xvfb..."
    
    if ! command -v Xvfb &> /dev/null; then
        echo "   [FIX] Installing Xvfb..."
        $SUDO apt-get install -y xvfb dbus-x11 2>/dev/null || true
    fi
    
    pkill -f "Xvfb :99" 2>/dev/null || true
    sleep 1
    
    export DISPLAY=:99
    Xvfb :99 -screen 0 1920x1080x24 &
    sleep 2
    
    if pgrep -f "Xvfb :99" > /dev/null; then
        echo "   [OK] Xvfb running on display :99"
    else
        echo "   [WARNING] Xvfb may need manual start"
    fi
}

fix_npm() {
    echo ""
    echo "[AUTO-FIX] Checking Node.js dependencies..."
    
    # Fix uuid ESM compatibility issue (v13+ is ESM-only, downgrade to v8 for CommonJS)
    if [ -f "package.json" ]; then
        if grep -q '"uuid": "\^1[0-9]' package.json 2>/dev/null; then
            echo "   [FIX] Fixing uuid ESM compatibility (downgrading to v8)..."
            sed -i 's/"uuid": "\^1[0-9][^"]*"/"uuid": "^8.3.2"/g' package.json
            rm -rf node_modules/uuid node_modules/.package-lock.json 2>/dev/null || true
        fi
    fi
    
    if [ ! -d "node_modules" ] || [ ! -f "node_modules/.package-lock.json" ]; then
        echo "   [FIX] Installing npm packages..."
        npm install --legacy-peer-deps 2>/dev/null || npm install
    fi
    echo "   [OK] Dependencies installed"
}

OS=$(detect_os)
echo "Detected OS: $OS"
echo ""

echo "[Step 1/9] System Update..."
if [ "$OS" = "ubuntu" ] || [ "$OS" = "debian" ]; then
    $SUDO apt-get update && $SUDO apt-get upgrade -y
elif [ "$OS" = "rhel" ] || [ "$OS" = "centos" ] || [ "$OS" = "fedora" ]; then
    $SUDO yum update -y || $SUDO dnf update -y
fi

echo ""
echo "[Step 2/9] Installing Essential Tools..."
if [ "$OS" = "ubuntu" ] || [ "$OS" = "debian" ]; then
    $SUDO apt-get install -y \
        curl \
        wget \
        git \
        build-essential \
        ca-certificates \
        gnupg \
        lsb-release \
        unzip \
        lsof \
        net-tools \
        netcat-openbsd \
        psmisc
elif [ "$OS" = "rhel" ] || [ "$OS" = "centos" ] || [ "$OS" = "fedora" ]; then
    $SUDO yum install -y curl wget git gcc-c++ make ca-certificates lsof psmisc
fi

echo ""
echo "[Step 3/9] Installing Node.js 20.x..."
if ! command -v node &> /dev/null; then
    if [ "$OS" = "ubuntu" ] || [ "$OS" = "debian" ]; then
        curl -fsSL https://deb.nodesource.com/setup_20.x | $SUDO -E bash -
        $SUDO apt-get install -y nodejs
    elif [ "$OS" = "rhel" ] || [ "$OS" = "centos" ] || [ "$OS" = "fedora" ]; then
        curl -fsSL https://rpm.nodesource.com/setup_20.x | $SUDO bash -
        $SUDO yum install -y nodejs || $SUDO dnf install -y nodejs
    fi
fi
echo "   Node.js: $(node --version)"
echo "   npm: $(npm --version)"

echo ""
echo "[Step 4/9] Installing Chromium & Browser Dependencies..."
if [ "$OS" = "ubuntu" ] || [ "$OS" = "debian" ]; then
    # Remove snap Chromium if installed (causes DevTools connection issues)
    if command -v snap &> /dev/null && snap list chromium &> /dev/null; then
        echo "   [FIX] Removing snap Chromium (causes connection issues)..."
        $SUDO snap remove chromium 2>/dev/null || true
    fi
    
    # Remove apt chromium-browser (often points to snap)
    if dpkg -l | grep -q chromium-browser; then
        echo "   [FIX] Removing chromium-browser package..."
        $SUDO apt-get remove -y chromium-browser 2>/dev/null || true
    fi
    
    # Add xtradeb PPA for native Chromium (more reliable than snap)
    echo "   [INFO] Adding xtradeb PPA for native Chromium..."
    $SUDO add-apt-repository -y ppa:xtradeb/apps 2>/dev/null || {
        echo "   [INFO] PPA already added or not available, continuing..."
    }
    $SUDO apt-get update
    
    # Install native Chromium from PPA
    echo "   [INFO] Installing native Chromium..."
    $SUDO apt-get install -y chromium 2>/dev/null || {
        echo "   [WARNING] xtradeb chromium not available, trying alternatives..."
        # Fallback to standard package if PPA fails
        $SUDO apt-get install -y chromium-browser 2>/dev/null || true
    }
    
    # Install browser dependencies
    $SUDO apt-get install -y \
        fonts-liberation \
        libasound2 \
        libatk-bridge2.0-0 \
        libatk1.0-0 \
        libatspi2.0-0 \
        libcups2 \
        libdbus-1-3 \
        libdrm2 \
        libgbm1 \
        libgtk-3-0 \
        libnspr4 \
        libnss3 \
        libx11-xcb1 \
        libxcomposite1 \
        libxdamage1 \
        libxfixes3 \
        libxkbcommon0 \
        libxrandr2 \
        xdg-utils \
        xvfb \
        dbus-x11 \
        software-properties-common \
        2>/dev/null || true
    
    mkdir -p /tmp/chromium-data
    chmod 777 /tmp/chromium-data
    
elif [ "$OS" = "rhel" ] || [ "$OS" = "centos" ] || [ "$OS" = "fedora" ]; then
    $SUDO yum install -y chromium xorg-x11-server-Xvfb || $SUDO dnf install -y chromium xorg-x11-server-Xvfb
fi

echo ""
echo "[Step 5/9] Installing & Configuring Tor (Multi-Instance Support)..."
fix_tor
setup_multi_tor
verify_tor_ips

echo ""
echo "[Step 6/9] Installing Project Dependencies..."
fix_npm

echo ""
echo "[Step 7/9] Creating Environment Config..."

CHROME_PATH=""
# Prefer native Chromium over snap (snap causes DevTools issues)
if [ -x "/usr/bin/chromium" ]; then
    CHROME_PATH="/usr/bin/chromium"
elif [ -x "$(which chromium 2>/dev/null)" ]; then
    CHROME_PATH=$(which chromium)
elif [ -x "$(which chromium-browser 2>/dev/null)" ]; then
    CHROME_PATH=$(which chromium-browser)
elif [ -x "$(which google-chrome 2>/dev/null)" ]; then
    CHROME_PATH=$(which google-chrome)
elif [ -x "$(which google-chrome-stable 2>/dev/null)" ]; then
    CHROME_PATH=$(which google-chrome-stable)
elif [ -x "/snap/bin/chromium" ]; then
    # Snap as last resort (may have connection issues)
    CHROME_PATH="/snap/bin/chromium"
    echo "   [WARNING] Using snap Chromium - may have DevTools connection issues"
else
    CHROME_PATH="/usr/bin/chromium"
fi

echo "   Detected Chrome path: $CHROME_PATH"

cat > .env << EOF
PORT=5000
NODE_ENV=production
CHROME_PATH=$CHROME_PATH
DISPLAY=:99
CHROME_DEVEL_SANDBOX=
PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true
EOF

echo "[OK] Created .env file"

echo ""
echo "[Step 8/9] Creating Self-Healing Start Script..."
cat > start.sh << 'SCRIPT'
#!/bin/bash

echo "FaucetSentry - Self-Healing Startup (Multi-Tor Support)"
echo "========================================================"

# Configuration
TOR_INSTANCE_COUNT=${TOR_INSTANCE_COUNT:-10}

fix_app_port() {
    local port=$1
    local pids=$(lsof -t -i:$port 2>/dev/null || true)
    if [ -n "$pids" ]; then
        echo "[FIX] Freeing port $port..."
        for pid in $pids; do
            kill -9 $pid 2>/dev/null || true
        done
        sleep 1
    fi
}

start_multi_tor() {
    echo "[MULTI-TOR] Checking/starting $TOR_INSTANCE_COUNT Tor instances..."
    
    # Count how many Tor ports are already available
    AVAILABLE=0
    for i in $(seq 1 $TOR_INSTANCE_COUNT); do
        SOCKS_PORT=$((9048 + (i * 2)))
        if nc -z 127.0.0.1 $SOCKS_PORT 2>/dev/null; then
            AVAILABLE=$((AVAILABLE + 1))
        fi
    done
    
    echo "[INFO] Currently $AVAILABLE Tor instances running"
    
    # If we have fewer than 2 instances, start all of them
    if [ $AVAILABLE -lt 2 ]; then
        echo "[FIX] Starting $TOR_INSTANCE_COUNT Tor instances..."
        
        # Stop system Tor service (we use manual instances)
        sudo systemctl stop tor 2>/dev/null || true
        pkill -9 -x tor 2>/dev/null || true
        sleep 2
        
        # Create data directories
        for i in $(seq 1 $TOR_INSTANCE_COUNT); do
            sudo mkdir -p /tmp/tor$i
            sudo chmod 700 /tmp/tor$i
        done
        
        # Start each Tor instance
        for i in $(seq 1 $TOR_INSTANCE_COUNT); do
            SOCKS_PORT=$((9048 + (i * 2)))
            CONTROL_PORT=$((9049 + (i * 2)))
            DATA_DIR="/tmp/tor$i"
            LOG_FILE="/tmp/tor$i.log"
            
            echo "   Starting Tor instance $i (SOCKS:$SOCKS_PORT, CTRL:$CONTROL_PORT)..."
            
            sudo tor --SocksPort $SOCKS_PORT \
                --ControlPort $CONTROL_PORT \
                --DataDirectory $DATA_DIR \
                --CookieAuthentication 0 \
                --Log "notice file $LOG_FILE" \
                --RunAsDaemon 1 2>/dev/null || echo "   [WARNING] Instance $i failed"
            
            sleep 1
        done
        
        echo "[INFO] Waiting for Tor circuits to establish..."
        sleep 15
        
        # Re-check availability
        AVAILABLE=0
        for i in $(seq 1 $TOR_INSTANCE_COUNT); do
            SOCKS_PORT=$((9048 + (i * 2)))
            if nc -z 127.0.0.1 $SOCKS_PORT 2>/dev/null; then
                AVAILABLE=$((AVAILABLE + 1))
            fi
        done
        
        echo "[OK] $AVAILABLE of $TOR_INSTANCE_COUNT Tor instances ready"
    else
        echo "[OK] Tor multi-instance already running ($AVAILABLE instances)"
    fi
}

fix_app_port 5000

# Start/verify multi-Tor instances
start_multi_tor

pkill -f "Xvfb :99" 2>/dev/null || true
sleep 1

export DISPLAY=:99
Xvfb :99 -screen 0 1920x1080x24 &
XVFB_PID=$!
sleep 2

if ! ps -p $XVFB_PID > /dev/null 2>&1; then
    echo "[WARNING] Xvfb may not be running"
fi

if [ ! -d "node_modules" ]; then
    echo "[FIX] Installing dependencies..."
    npm install --legacy-peer-deps 2>/dev/null || npm install
fi

# Prefer native Chromium over snap (snap causes DevTools issues)
if [ -x "/usr/bin/chromium" ]; then
    export CHROME_PATH="/usr/bin/chromium"
elif [ -x "$(which chromium 2>/dev/null)" ]; then
    export CHROME_PATH=$(which chromium)
elif [ -x "$(which chromium-browser 2>/dev/null)" ]; then
    export CHROME_PATH=$(which chromium-browser)
elif [ -x "/snap/bin/chromium" ]; then
    export CHROME_PATH="/snap/bin/chromium"
    echo "[WARNING] Using snap Chromium - may have DevTools issues"
fi

export CHROME_DEVEL_SANDBOX=
export PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true

mkdir -p /tmp/chromium-data
chmod 777 /tmp/chromium-data 2>/dev/null || true

echo "[OK] Chrome path: ${CHROME_PATH:-auto-detect}"
echo "[OK] Starting server..."

cleanup() {
    echo "Shutting down..."
    kill $XVFB_PID 2>/dev/null || true
    pkill -f "chromium" 2>/dev/null || true
    exit 0
}
trap cleanup SIGINT SIGTERM

while true; do
    node server/index.js
    EXIT_CODE=$?
    
    if [ $EXIT_CODE -ne 0 ]; then
        echo "[AUTO-RESTART] Server crashed (exit $EXIT_CODE), restarting in 5 seconds..."
        sleep 5
        
        fix_app_port 5000
        
        pkill -f "chromium" 2>/dev/null || true
        sleep 1
        
        # Restart multi-Tor if needed
        start_multi_tor
    else
        break
    fi
done
SCRIPT
chmod +x start.sh
echo "[OK] Created start.sh (self-healing with multi-Tor)"

echo ""
echo "[Step 9/9] Creating Systemd Service..."
CURRENT_DIR=$(pwd)
CURRENT_USER=${SUDO_USER:-$USER}

cat > faucet-sentry.service << EOF
[Unit]
Description=FaucetSentry Auto-Claim Dashboard
After=network.target tor.service

[Service]
Type=simple
User=$CURRENT_USER
WorkingDirectory=$CURRENT_DIR
Environment=NODE_ENV=production
Environment=PORT=5000
Environment=CHROME_PATH=$CHROME_PATH
Environment=DISPLAY=:99
ExecStartPre=/bin/bash -c 'pkill -f "Xvfb :99" || true'
ExecStartPre=/bin/bash -c 'Xvfb :99 -screen 0 1920x1080x24 &'
ExecStart=$CURRENT_DIR/start.sh
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF

echo "[OK] Created faucet-sentry.service"

mkdir -p data
echo "[OK] Data directory ready"

echo ""
echo "========================================================"
echo "               SETUP COMPLETE!"
echo "========================================================"
echo ""
echo "QUICK START:"
echo "   ./start.sh              # Self-healing startup (recommended)"
echo "   node server/index.js    # Direct start"
echo ""
echo "DASHBOARD URL:"
echo "   http://localhost:5000"
echo "   http://$(hostname -I 2>/dev/null | awk '{print $1}' || echo 'YOUR_IP'):5000"
echo ""
echo "MULTI-TOR INSTANCES (for Multi-Instance Claiming):"
echo "   This setup configured $TOR_INSTANCE_COUNT Tor instances for parallel claiming:"
echo ""
echo "   Instance 1:  SOCKS=9050, Control=9051"
echo "   Instance 2:  SOCKS=9052, Control=9053"
echo "   Instance 3:  SOCKS=9054, Control=9055"
echo "   Instance 4:  SOCKS=9056, Control=9057"
echo "   Instance 5:  SOCKS=9058, Control=9059"
echo "   Instance 6:  SOCKS=9060, Control=9061"
echo "   Instance 7:  SOCKS=9062, Control=9063"
echo "   Instance 8:  SOCKS=9064, Control=9065"
echo "   Instance 9:  SOCKS=9066, Control=9067"
echo "   Instance 10: SOCKS=9068, Control=9069"
echo ""
echo "   Check status: nc -z 127.0.0.1 9050 && echo 'Instance 1 OK'"
echo "   Verify IPs:   curl --socks5 127.0.0.1:9050 https://api.ipify.org"
echo ""
echo "   If Tor instances stop, start.sh will auto-restart them."
echo ""
echo "AUTO-FIX FEATURES:"
echo "   - Auto-kills processes blocking ports"
echo "   - Auto-restarts multi-Tor instances if stopped"
echo "   - Auto-restarts server on crash"
echo "   - Auto-installs missing dependencies"
echo "   - Tracks used IPs to avoid detection"
echo "   - Fresh user agent every session"
echo ""
echo "INSTALL AS SYSTEM SERVICE:"
echo "   sudo cp faucet-sentry.service /etc/systemd/system/"
echo "   sudo systemctl daemon-reload"
echo "   sudo systemctl enable faucet-sentry"
echo "   sudo systemctl start faucet-sentry"
echo ""
echo "VIEW SERVICE LOGS:"
echo "   sudo journalctl -u faucet-sentry -f"
echo ""
echo "TROUBLESHOOTING MULTI-INSTANCE:"
echo "   - If 'Only X Tor ports available' error appears:"
echo "     Run: sudo ./vm-setup.sh   (to re-setup Tor instances)"
echo "   - Or manually start Tor instances:"
echo "     ./start.sh   (auto-starts Tor instances)"
echo ""
