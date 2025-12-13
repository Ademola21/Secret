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
    
    TOR_CONFIG="/etc/tor/torrc"
    
    # Stop Tor before modifying config
    $SUDO systemctl stop tor 2>/dev/null || pkill -x tor 2>/dev/null || true
    sleep 1
    
    # Create/update Tor config with required settings
    if [ -f "$TOR_CONFIG" ]; then
        echo "   [FIX] Configuring Tor for identity rotation..."
        
        # Remove any existing control port settings to avoid duplicates
        $SUDO sed -i '/^ControlPort/d' "$TOR_CONFIG" 2>/dev/null || true
        $SUDO sed -i '/^CookieAuthentication/d' "$TOR_CONFIG" 2>/dev/null || true
        $SUDO sed -i '/^HashedControlPassword/d' "$TOR_CONFIG" 2>/dev/null || true
        
        # Add fresh control port configuration
        echo "" | $SUDO tee -a "$TOR_CONFIG" > /dev/null
        echo "# FaucetSentry - Tor Control Port Configuration" | $SUDO tee -a "$TOR_CONFIG" > /dev/null
        echo "ControlPort 9051" | $SUDO tee -a "$TOR_CONFIG" > /dev/null
        echo "CookieAuthentication 0" | $SUDO tee -a "$TOR_CONFIG" > /dev/null
        
        echo "   [OK] Tor control port configured on 9051"
    else
        # Create config file if it doesn't exist
        echo "   [FIX] Creating Tor configuration..."
        $SUDO mkdir -p /etc/tor
        cat << TORCONF | $SUDO tee "$TOR_CONFIG" > /dev/null
# Tor configuration for FaucetSentry
SocksPort 9050
ControlPort 9051
CookieAuthentication 0
Log notice syslog
DataDirectory /var/lib/tor
TORCONF
    fi
    
    check_port 9050
    check_port 9051
    
    # Enable and start Tor service
    $SUDO systemctl daemon-reload 2>/dev/null || true
    $SUDO systemctl enable tor 2>/dev/null || true
    $SUDO systemctl start tor 2>/dev/null || {
        echo "   [INFO] systemctl failed, trying direct start..."
        $SUDO tor &
    }
    sleep 3
    
    # Verify Tor is running and control port is accessible
    if $SUDO systemctl is-active --quiet tor 2>/dev/null || pgrep -x tor > /dev/null; then
        echo "   [OK] Tor is running"
        
        # Test control port connection
        if command -v nc &> /dev/null; then
            if nc -z 127.0.0.1 9051 2>/dev/null; then
                echo "   [OK] Tor control port 9051 is accessible"
            else
                echo "   [WARNING] Control port 9051 not accessible yet, may need a moment..."
            fi
        fi
    else
        echo "   [WARNING] Tor may need manual start: sudo systemctl start tor"
    fi
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
echo "[Step 5/9] Installing & Configuring Tor..."
fix_tor

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

echo "FaucetSentry - Self-Healing Startup"
echo "===================================="

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

fix_app_port 5000

fix_tor_control() {
    # Ensure Tor control port is configured and accessible
    TOR_CONFIG="/etc/tor/torrc"
    
    if [ -f "$TOR_CONFIG" ]; then
        if ! grep -q "^ControlPort 9051" "$TOR_CONFIG" 2>/dev/null; then
            echo "[FIX] Adding Tor control port configuration..."
            sudo sed -i '/^ControlPort/d' "$TOR_CONFIG" 2>/dev/null || true
            sudo sed -i '/^CookieAuthentication/d' "$TOR_CONFIG" 2>/dev/null || true
            echo "ControlPort 9051" | sudo tee -a "$TOR_CONFIG" > /dev/null
            echo "CookieAuthentication 0" | sudo tee -a "$TOR_CONFIG" > /dev/null
            return 1  # Signal restart needed
        fi
    fi
    return 0
}

# Check and fix Tor
RESTART_TOR=0
if ! pgrep -x tor > /dev/null; then
    echo "[INFO] Tor not running..."
    RESTART_TOR=1
fi

# Fix control port config if needed
fix_tor_control || RESTART_TOR=1

if [ $RESTART_TOR -eq 1 ]; then
    echo "[INFO] Starting/restarting Tor service..."
    sudo systemctl restart tor 2>/dev/null || sudo systemctl start tor 2>/dev/null || {
        echo "[WARNING] systemctl failed, trying direct start..."
        sudo tor &
    }
    sleep 3
fi

# Verify Tor control port is accessible
MAX_WAIT=10
WAITED=0
while [ $WAITED -lt $MAX_WAIT ]; do
    if nc -z 127.0.0.1 9051 2>/dev/null; then
        echo "[OK] Tor control port 9051 is accessible"
        break
    fi
    sleep 1
    WAITED=$((WAITED + 1))
done

if [ $WAITED -eq $MAX_WAIT ]; then
    echo "[WARNING] Tor control port not accessible - identity rotation may not work"
    echo "[TIP] Try: sudo systemctl restart tor"
fi

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
        
        if ! pgrep -x tor > /dev/null; then
            echo "[INFO] Tor not running - attempting restart..."
            sudo systemctl restart tor 2>/dev/null || echo "[WARNING] Run: sudo systemctl start tor"
            sleep 3
        fi
    else
        break
    fi
done
SCRIPT
chmod +x start.sh
echo "[OK] Created start.sh (self-healing)"

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
echo "TOR STATUS:"
echo "   sudo systemctl status tor"
echo "   Tor SOCKS5: 127.0.0.1:9050"
echo "   Tor Control: 127.0.0.1:9051"
echo ""
echo "AUTO-FIX FEATURES:"
echo "   - Auto-kills processes blocking ports"
echo "   - Auto-restarts Tor if stopped"
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
