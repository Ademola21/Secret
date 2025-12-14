let puppeteer = require("rebrowser-puppeteer-core");
const { pageController } = require("./module/pageController.js");
const { spawn } = require('child_process');
const http = require('http');
const fs = require('fs');
let Xvfb;
try {
  Xvfb = require("xvfb");
} catch {
  // ignore
}

async function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function findChromePath(customPath) {
  if (customPath && fs.existsSync(customPath)) {
    return customPath;
  }
  
  const possiblePaths = [
    process.env.CHROME_PATH,
    '/nix/store/qa9cnw4v5xkxyip6mb9kxqfq1z4x2dx1-chromium-138.0.7204.100/bin/chromium',
    '/usr/bin/chromium-browser',
    '/usr/bin/chromium',
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/snap/bin/chromium',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  ];
  
  for (const p of possiblePaths) {
    try {
      if (p && fs.existsSync(p)) {
        return p;
      }
    } catch (e) {
      continue;
    }
  }
  
  return null;
}

async function getAvailablePort() {
  return new Promise((resolve, reject) => {
    const server = require('net').createServer();
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      server.close(() => resolve(port));
    });
    server.on('error', reject);
  });
}

async function waitForDevTools(port, maxRetries = 40, initialDelay = 500) {
  // Use exponential backoff: start with initialDelay, increase up to 2 seconds
  let currentDelay = initialDelay;
  const maxDelay = 2000;
  
  for (let i = 0; i < maxRetries; i++) {
    try {
      const result = await new Promise((resolve, reject) => {
        const req = http.get(`http://127.0.0.1:${port}/json/version`, (res) => {
          let data = '';
          res.on('data', chunk => data += chunk);
          res.on('end', () => {
            try {
              resolve(JSON.parse(data));
            } catch (e) {
              reject(e);
            }
          });
        });
        req.on('error', reject);
        req.setTimeout(3000, () => {
          req.destroy();
          reject(new Error('Timeout'));
        });
      });
      return result;
    } catch (err) {
      if (i < maxRetries - 1) {
        await sleep(currentDelay);
        // Exponential backoff with cap
        currentDelay = Math.min(currentDelay * 1.3, maxDelay);
      }
    }
  }
  throw new Error(`Chrome DevTools not available on port ${port} after ${maxRetries} retries`);
}

async function launchChrome(chromePath, args, port) {
  const chromeArgs = [
    ...args,
    `--remote-debugging-port=${port}`,
  ];
  
  const chromeProcess = spawn(chromePath, chromeArgs, {
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  
  let processExited = false;
  let exitError = null;
  
  chromeProcess.stdout.on('data', () => {});
  chromeProcess.stderr.on('data', (data) => {
    const msg = data.toString();
    if (msg.includes('DevTools listening on')) {
      // Chrome is ready - this is a good sign
    }
  });
  
  chromeProcess.on('error', (err) => {
    processExited = true;
    exitError = err;
    console.error('Chrome process error:', err.message);
  });
  
  chromeProcess.on('exit', (code, signal) => {
    processExited = true;
    if (code !== null && code !== 0) {
      exitError = new Error(`Chrome exited with code ${code}`);
    }
  });
  
  // Give Chrome initial time to start, checking periodically if process is still alive
  const startTime = Date.now();
  const maxInitialWait = 3000; // 3 seconds max initial wait
  const checkInterval = 100;
  
  while (Date.now() - startTime < maxInitialWait) {
    if (processExited) {
      throw exitError || new Error('Chrome process exited unexpectedly');
    }
    
    // Check if process is still running
    try {
      process.kill(chromeProcess.pid, 0);
    } catch (e) {
      throw new Error('Chrome process died immediately after launch');
    }
    
    await sleep(checkInterval);
    
    // Try to connect early if possible
    try {
      const req = http.get(`http://127.0.0.1:${port}/json/version`, (res) => {
        res.destroy();
      });
      req.on('error', () => {});
      req.setTimeout(100, () => req.destroy());
      // If we get here without error, Chrome might be ready
      if (Date.now() - startTime > 500) {
        break; // Give it at least 500ms before early exit
      }
    } catch (e) {
      // Not ready yet, continue waiting
    }
  }
  
  return chromeProcess;
}

async function connect({
  args = [],
  headless = false,
  customConfig = {},
  proxy = {},
  turnstile = false,
  connectOption = {},
  disableXvfb = false,
  plugins = [],
  ignoreAllFlags = false,
} = {}) {
  let xvfbsession = null;
  if (headless == "auto") headless = false;

  if (process.platform === "linux" && disableXvfb === false) {
    try {
      xvfbsession = new Xvfb({
        silent: true,
        xvfb_args: ["-screen", "0", "1920x1080x24", "-ac"],
      });
      xvfbsession.startSync();
    } catch (err) {
      console.log(
        "You are running on a Linux platform but do not have xvfb installed. The browser can be captured. Please install it with the following command\n\nsudo apt-get install xvfb\n\n" +
          err.message
      );
    }
  }

  const chromePath = findChromePath(customConfig.chromePath);
  if (!chromePath) {
    throw new Error('Chrome/Chromium not found. Please set CHROME_PATH environment variable.');
  }

  const port = await getAvailablePort();
  
  let chromeFlags = [
    '--no-sandbox',
    '--disable-setuid-sandbox',
    '--disable-dev-shm-usage',
    '--disable-gpu',
    '--disable-software-rasterizer',
    '--disable-accelerated-2d-canvas',
    '--disable-background-networking',
    '--disable-default-apps',
    '--disable-extensions',
    '--disable-sync',
    '--disable-translate',
    '--disable-background-timer-throttling',
    '--disable-renderer-backgrounding',
    '--disable-backgrounding-occluded-windows',
    '--disable-ipc-flooding-protection',
    '--disable-hang-monitor',
    '--disable-component-update',
    '--disable-domain-reliability',
    '--disable-features=TranslateUI,BlinkGenPropertyTrees,AutomationControlled',
    '--no-first-run',
    '--no-default-browser-check',
    '--metrics-recording-only',
    '--mute-audio',
    // Additional stability flags for VM/snap environments
    '--disable-web-security',
    '--allow-running-insecure-content',
    '--disable-client-side-phishing-detection',
    '--disable-popup-blocking',
    '--disable-prompt-on-repost',
    '--ignore-certificate-errors',
    '--disable-breakpad',
    '--disable-infobars',
    '--single-process',  // Important for snap-based Chrome on Ubuntu VMs
    '--no-zygote',       // Important for snap-based Chrome on Ubuntu VMs
    ...args,
  ];

  if (headless !== false) {
    chromeFlags.push(`--headless=${headless}`);
  }
  
  if (proxy && proxy.host && proxy.port) {
    chromeFlags.push(`--proxy-server=${proxy.host}:${proxy.port}`);
  }

  const chromeProcess = await launchChrome(chromePath, chromeFlags, port);
  
  // Increased retries and exponential backoff for VM environments
  await waitForDevTools(port, 40, 500);

  if (plugins.length > 0) {
    const { addExtra } = await import("puppeteer-extra");
    puppeteer = addExtra(puppeteer);
    for (const item of plugins) {
      puppeteer.use(item);
    }
  }

  let browser;
  let lastError;
  const maxConnectAttempts = 8;  // Increased from 5 for VM environments
  
  for (let attempt = 0; attempt < maxConnectAttempts; attempt++) {
    try {
      browser = await puppeteer.connect({
        browserURL: `http://127.0.0.1:${port}`,
        ...connectOption,
      });
      break;
    } catch (err) {
      lastError = err;
      if (attempt < maxConnectAttempts - 1) {
        // Exponential backoff: 1s, 1.5s, 2s, 2.5s, 3s, 3.5s, 4s
        const delay = 1000 + (attempt * 500);
        await sleep(delay);
      }
    }
  }
  
  if (!browser) {
    try {
      chromeProcess.kill('SIGKILL');
    } catch (e) {}
    throw lastError || new Error('Failed to connect to Chrome');
  }

  let [page] = await browser.pages();

  let pageControllerConfig = {
    browser,
    page,
    proxy,
    turnstile,
    xvfbsession,
    pid: chromeProcess.pid,
    plugins,
  };

  const chromeLauncher = {
    kill: () => {
      try {
        chromeProcess.kill('SIGKILL');
      } catch (e) {}
    },
    pid: chromeProcess.pid,
    port: port,
  };

  page = await pageController({
    ...pageControllerConfig,
    killProcess: true,
    chrome: chromeLauncher,
  });

  browser.on("targetcreated", async (target) => {
    if (target.type() === "page") {
      let newPage = await target.page();
      pageControllerConfig.page = newPage;
      newPage = await pageController(pageControllerConfig);
    }
  });

  return {
    browser,
    page,
  };
}

module.exports = { connect };
