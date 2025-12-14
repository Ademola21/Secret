#!/bin/bash

echo "Puppeteer Real Browser - Auto Setup Script"
echo "=============================================="
echo ""

detect_environment() {
    if [ -n "$REPL_ID" ] || [ -n "$REPL_SLUG" ]; then
        echo "replit"
    elif [ -f /etc/nix/nix.conf ]; then
        echo "nix"
    elif [ -f /etc/debian_version ]; then
        echo "debian"
    elif [ -f /etc/redhat-release ]; then
        echo "redhat"
    elif [ -f /etc/arch-release ]; then
        echo "arch"
    else
        echo "unknown"
    fi
}

check_port_usage() {
    local port=$1
    echo "Checking port $port..."
    local pids=""
    
    if command -v lsof &> /dev/null; then
        pids=$(lsof -t -i:$port 2>/dev/null)
    elif command -v ss &> /dev/null; then
        pids=$(ss -tlnp | grep ":$port " | grep -oP 'pid=\K[0-9]+' 2>/dev/null)
    fi
    
    if [ -n "$pids" ]; then
        echo "   [WARNING] Port $port is in use by process(es): $pids"
        echo "   If you need to use this port, stop those processes manually."
        return 1
    else
        echo "   [OK] Port $port is available"
        return 0
    fi
}

check_command() {
    if command -v "$1" &> /dev/null; then
        echo "[OK] $1 is installed"
        return 0
    else
        echo "[MISSING] $1 is NOT installed"
        return 1
    fi
}

ENV=$(detect_environment)
echo "Detected environment: $ENV"
echo ""

if [ "$EUID" -ne 0 ] && [ "$ENV" != "replit" ]; then
    SUDO="sudo"
else
    SUDO=""
fi

echo "Checking Node.js..."
if check_command node; then
    echo "   Version: $(node --version)"
else
    echo "   Installing Node.js..."
    if [ "$ENV" = "debian" ]; then
        curl -fsSL https://deb.nodesource.com/setup_20.x | $SUDO -E bash -
        $SUDO apt-get install -y nodejs
    elif [ "$ENV" = "redhat" ]; then
        curl -fsSL https://rpm.nodesource.com/setup_20.x | $SUDO bash -
        $SUDO yum install -y nodejs
    elif [ "$ENV" = "arch" ]; then
        $SUDO pacman -S --noconfirm nodejs npm
    elif [ "$ENV" = "replit" ]; then
        echo "   Node.js should be available in Replit. Check your repl configuration."
    fi
fi

echo ""
echo "Checking npm..."
if check_command npm; then
    echo "   Version: $(npm --version)"
fi

echo ""
echo "Checking Chromium/Chrome..."
CHROME_PATHS=(
    "/usr/bin/chromium"
    "/usr/bin/chromium-browser"
    "/usr/bin/google-chrome"
    "/usr/bin/google-chrome-stable"
    "/snap/bin/chromium"
    "/nix/store/*/bin/chromium"
)

find_chrome() {
    for pattern in "${CHROME_PATHS[@]}"; do
        for path in $pattern; do
            if [ -x "$path" ]; then
                echo "$path"
                return 0
            fi
        done
    done
    
    if command -v chromium &> /dev/null; then
        command -v chromium
        return 0
    fi
    if command -v chromium-browser &> /dev/null; then
        command -v chromium-browser
        return 0
    fi
    if command -v google-chrome &> /dev/null; then
        command -v google-chrome
        return 0
    fi
    
    return 1
}

CHROME_PATH=$(find_chrome)
if [ -n "$CHROME_PATH" ]; then
    echo "[OK] Chromium found at: $CHROME_PATH"
else
    echo "[MISSING] Chromium not found, attempting to install..."
    if [ "$ENV" = "debian" ]; then
        $SUDO apt-get update
        $SUDO apt-get install -y chromium-browser || $SUDO apt-get install -y chromium
    elif [ "$ENV" = "redhat" ]; then
        $SUDO yum install -y chromium
    elif [ "$ENV" = "arch" ]; then
        $SUDO pacman -S --noconfirm chromium
    elif [ "$ENV" = "replit" ]; then
        echo "   Chromium should be available via Nix packages in Replit."
        echo "   The system will auto-detect Chrome path at runtime."
    fi
    CHROME_PATH=$(find_chrome)
fi

echo ""
echo "Installing Node.js dependencies..."
if [ -f "package.json" ]; then
    npm install --legacy-peer-deps 2>/dev/null || npm install
    echo "[OK] Dependencies installed"
else
    echo "[ERROR] package.json not found!"
fi

echo ""
echo "Setting up environment variables..."
if [ "$ENV" = "replit" ]; then
    echo "PORT=5000" > .env.local
    echo "NODE_ENV=production" >> .env.local
    if [ -n "$CHROME_PATH" ]; then
        echo "CHROME_PATH=$CHROME_PATH" >> .env.local
    fi
    echo "[OK] Created .env.local for Replit"
else
    cat > .env << EOF
PORT=5000
NODE_ENV=production
CHROME_PATH=${CHROME_PATH:-/usr/bin/chromium-browser}
EOF
    echo "[OK] Created .env"
fi

echo ""
echo "Checking Tor setup..."
if command -v tor &> /dev/null; then
    echo "[OK] Tor is available"
    check_port_usage 9050
    check_port_usage 9051
elif [ "$ENV" = "replit" ]; then
    echo "[INFO] Tor is available via the Tor Service workflow"
    check_port_usage 9050
    check_port_usage 9051
else
    echo "[INFO] Tor is not installed. For FaucetSentry Tor mode:"
    echo "       Ubuntu/Debian: sudo apt-get install tor"
    echo "       RHEL/Fedora: sudo dnf install tor"
fi

echo ""
echo "Creating data directory..."
mkdir -p data
echo "[OK] Data directory ready"

echo ""
echo "=============================================="
echo "Setup Complete!"
echo "=============================================="
echo ""
echo "Start the server:"
echo "   node server/index.js"
echo ""
echo "Dashboard URL: http://localhost:5000"
echo ""
echo "For Tor support (FaucetSentry):"
echo "   - Replit: Tor runs as a separate workflow on port 9050"
echo "   - Linux: Install tor and ensure it runs on port 9050"
echo ""
echo "Auto-restart feature:"
echo "   - Works with Tor/Proxy modes"
echo "   - Automatically starts new session after successful claim"
echo "   - Auto-retries with new identity on rate limit errors"
echo ""
