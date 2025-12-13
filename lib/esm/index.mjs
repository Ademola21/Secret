import puppeteer from "rebrowser-puppeteer-core";
import { pageController } from "./module/pageController.mjs";
import { spawn } from 'child_process';
import http from "http";
import fs from "fs";
import net from "net";

function sleep(ms) {
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
    const server = net.createServer();
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      server.close(() => resolve(port));
    });
    server.on('error', reject);
  });
}

async function waitForDevTools(port, maxRetries = 20, retryDelay = 500) {
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
        req.setTimeout(2000, () => {
          req.destroy();
          reject(new Error('Timeout'));
        });
      });
      return result;
    } catch (err) {
      if (i < maxRetries - 1) {
        await sleep(retryDelay);
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
  
  chromeProcess.stdout.on('data', () => {});
  chromeProcess.stderr.on('data', () => {});
  
  chromeProcess.on('error', (err) => {
    console.error('Chrome process error:', err.message);
  });
  
  await sleep(1000);
  
  return chromeProcess;
}

export async function connect({
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
      const { default: Xvfb } = await import("xvfb");
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
    ...args,
  ];

  if (headless !== false) {
    chromeFlags.push(`--headless=${headless}`);
  }
  
  if (proxy && proxy.host && proxy.port) {
    chromeFlags.push(`--proxy-server=${proxy.host}:${proxy.port}`);
  }

  const chromeProcess = await launchChrome(chromePath, chromeFlags, port);
  
  await waitForDevTools(port, 20, 500);

  let pextra = null;
  if (plugins.length > 0) {
    const { addExtra } = await import("puppeteer-extra");
    pextra = addExtra(puppeteer);
    for (const item of plugins) {
      pextra.use(item);
    }
  }

  let browser;
  let lastError;
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      browser = await (pextra ? pextra : puppeteer).connect({
        browserURL: `http://127.0.0.1:${port}`,
        ...connectOption,
      });
      break;
    } catch (err) {
      lastError = err;
      if (attempt < 4) {
        await sleep(1000);
      }
    }
  }
  
  if (!browser) {
    chromeProcess.kill('SIGKILL');
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
    chrome: chromeLauncher,
    killProcess: true,
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
