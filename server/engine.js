const { v4: uuidv4 } = require('uuid');
const EventEmitter = require('events');
const { CaptchaSolver } = require('./captcha-solver');
const { BehaviorSimulator } = require('./behavior-simulator');
const { stateManager } = require('./state-manager');

class AutomationEngine extends EventEmitter {
  constructor(io) {
    super();
    this.io = io;
    this.activeTasks = new Map();
    this.logs = stateManager.getAutomationLogs(1000);
    this.maxLogs = 1000;
    this.browserReady = false;
    this.captchaSolver = new CaptchaSolver(this);
    this.behaviorSimulator = new BehaviorSimulator(this);
    
    this.taskTypes = {
      'bot-detection-test': {
        name: 'Bot Detection Test',
        description: 'Test if browser passes bot detection on various sites',
        icon: '🤖'
      },
      'cloudflare-turnstile': {
        name: 'Cloudflare Turnstile Test',
        description: 'Test automatic Cloudflare Turnstile solving',
        icon: '☁️'
      },
      'fingerprint-test': {
        name: 'Fingerprint Test',
        description: 'Check browser fingerprint detection status',
        icon: '🔍'
      },
      'custom-navigate': {
        name: 'Custom Navigation',
        description: 'Navigate to a custom URL and perform actions',
        icon: '🌐'
      },
      'web-scraper': {
        name: 'Web Scraper',
        description: 'Extract data from websites with anti-bot protection',
        icon: '🕷️'
      },
      'form-automation': {
        name: 'Form Automation',
        description: 'Auto-fill and submit forms with human-like behavior',
        icon: '📝'
      },
      'session-recorder': {
        name: 'Session Recorder',
        description: 'Record browser sessions and capture all network activity',
        icon: '🎥'
      },
      'multi-page-crawler': {
        name: 'Multi-Page Crawler',
        description: 'Crawl multiple pages and extract structured data',
        icon: '🔗'
      },
      'screenshot-batch': {
        name: 'Batch Screenshots',
        description: 'Take screenshots of multiple URLs in sequence',
        icon: '📸'
      },
      'performance-audit': {
        name: 'Performance Audit',
        description: 'Analyze page load performance and metrics',
        icon: '⚡'
      },
      'captcha-solver': {
        name: 'CAPTCHA Solver',
        description: 'Detect and solve image CAPTCHAs using OCR',
        icon: '🔓'
      },
      'recaptcha-v3-test': {
        name: 'reCAPTCHA v3 Test',
        description: 'Test and optimize reCAPTCHA v3 bypass',
        icon: '🛡️'
      },
      'behavior-simulation': {
        name: 'Human Behavior Sim',
        description: 'Simulate realistic human browsing patterns',
        icon: '🧠'
      }
    };
  }

  log(level, message, taskId = null, metadata = {}) {
    const entry = {
      id: uuidv4(),
      timestamp: new Date().toISOString(),
      level,
      message,
      taskId,
      metadata
    };
    
    this.logs.unshift(entry);
    if (this.logs.length > this.maxLogs) {
      this.logs.pop();
    }
    
    stateManager.addAutomationLog(entry);
    this.io.emit('log', entry);
    
    const icon = {
      info: 'ℹ️',
      success: '✅',
      warning: '⚠️',
      error: '❌',
      action: '🎯'
    }[level] || '📝';
    
    console.log(`${icon} [${level.toUpperCase()}] ${message}`);
    
    return entry;
  }

  getLogs(limit = 100) {
    return this.logs.slice(0, limit);
  }

  clearLogs() {
    this.logs = [];
    stateManager.clearLogs('automation');
  }

  getStatus() {
    return {
      isRunning: this.activeTasks.size > 0,
      browserReady: this.browserReady,
      activeTaskCount: this.activeTasks.size,
      totalLogsCount: this.logs.length
    };
  }

  getActiveTasks() {
    const tasks = [];
    for (const [id, task] of this.activeTasks) {
      tasks.push({
        id,
        type: task.type,
        status: task.status,
        startTime: task.startTime,
        url: task.currentUrl || null
      });
    }
    return tasks;
  }

  getTaskTypes() {
    return this.taskTypes;
  }

  async startTask(taskType, options = {}) {
    const taskId = uuidv4();
    
    if (!this.taskTypes[taskType]) {
      throw new Error(`Unknown task type: ${taskType}`);
    }

    const task = {
      id: taskId,
      type: taskType,
      status: 'starting',
      startTime: new Date().toISOString(),
      options,
      browser: null,
      page: null,
      currentUrl: null
    };

    this.activeTasks.set(taskId, task);
    this.emitUpdate();
    
    this.log('info', `Starting task: ${this.taskTypes[taskType].name}`, taskId);

    this.runTask(task).catch(err => {
      this.log('error', `Task failed: ${err.message}`, taskId);
      task.status = 'failed';
      task.error = err.message;
      this.emitUpdate();
    });

    return taskId;
  }

  findChromePath() {
    const fs = require('fs');
    const { execSync } = require('child_process');
    
    // First try to find dynamically (most reliable for Nix)
    try {
      const result = execSync('which chromium || which chromium-browser || which google-chrome', { encoding: 'utf8' });
      const path = result.trim();
      if (path && fs.existsSync(path)) {
        return path;
      }
    } catch (e) {
      // Continue to fallback paths
    }
    
    // Check environment variable
    if (process.env.CHROME_PATH && fs.existsSync(process.env.CHROME_PATH)) {
      return process.env.CHROME_PATH;
    }
    
    // Fallback paths for various systems
    const possiblePaths = [
      '/usr/bin/chromium-browser',
      '/usr/bin/chromium',
      '/usr/bin/google-chrome',
      '/usr/bin/google-chrome-stable',
      '/snap/bin/chromium'
    ];

    for (const p of possiblePaths) {
      try {
        if (fs.existsSync(p)) {
          return p;
        }
      } catch (e) {
        continue;
      }
    }

    throw new Error('Chrome/Chromium not found. Please install Chromium or set CHROME_PATH environment variable.');
  }

  async runTask(task) {
    try {
      const { connect } = require('../lib/cjs/index.js');
      
      this.log('info', 'Launching browser...', task.id);
      task.status = 'launching';
      this.emitUpdate();

      const chromePath = this.findChromePath();
      this.log('info', `Using Chrome at: ${chromePath}`, task.id);
      
      const { browser, page } = await connect({
        headless: 'new',
        turnstile: true,
        disableXvfb: true,
        args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu', '--disable-software-rasterizer', '--disable-background-networking', '--disable-default-apps', '--disable-extensions', '--disable-sync', '--no-first-run', '--remote-debugging-port=0'],
        customConfig: {
          chromePath: chromePath
        },
        connectOption: {
          defaultViewport: { width: 1280, height: 720 }
        }
      });

      task.browser = browser;
      task.page = page;
      task.status = 'running';
      this.browserReady = true;
      this.emitUpdate();

      this.log('success', 'Browser launched successfully', task.id);

      this.setupPageListeners(task);
      
      // Start live screenshot streaming (updates every 500ms for smooth viewing)
      this.startLiveStream(task);

      switch (task.type) {
        case 'bot-detection-test':
          await this.runBotDetectionTest(task);
          break;
        case 'cloudflare-turnstile':
          await this.runCloudflareTest(task);
          break;
        case 'fingerprint-test':
          await this.runFingerprintTest(task);
          break;
        case 'custom-navigate':
          await this.runCustomNavigation(task);
          break;
        case 'web-scraper':
          await this.runWebScraper(task);
          break;
        case 'form-automation':
          await this.runFormAutomation(task);
          break;
        case 'session-recorder':
          await this.runSessionRecorder(task);
          break;
        case 'multi-page-crawler':
          await this.runMultiPageCrawler(task);
          break;
        case 'screenshot-batch':
          await this.runScreenshotBatch(task);
          break;
        case 'performance-audit':
          await this.runPerformanceAudit(task);
          break;
        case 'captcha-solver':
          await this.runCaptchaSolver(task);
          break;
        case 'recaptcha-v3-test':
          await this.runRecaptchaV3Test(task);
          break;
        case 'behavior-simulation':
          await this.runBehaviorSimulation(task);
          break;
      }

      task.status = 'completed';
      this.log('success', `Task completed: ${this.taskTypes[task.type].name}`, task.id);
      
    } catch (error) {
      this.log('error', `Error: ${error.message}`, task.id, { stack: error.stack });
      task.status = 'failed';
      task.error = error.message;
      // Stop live stream immediately on error
      this.stopLiveStream(task);
    } finally {
      // Ensure stream is stopped before cleanup
      this.stopLiveStream(task);
      await this.cleanupTask(task);
    }
  }

  setupPageListeners(task) {
    const page = task.page;
    
    page.on('console', msg => {
      if (msg.type() === 'error') {
        this.log('warning', `Console error: ${msg.text()}`, task.id);
      }
    });

    page.on('pageerror', error => {
      this.log('error', `Page error: ${error.message}`, task.id);
    });

    page.on('requestfailed', request => {
      this.log('warning', `Request failed: ${request.url().substring(0, 100)}`, task.id);
    });

    page.on('framenavigated', frame => {
      if (frame === page.mainFrame()) {
        task.currentUrl = frame.url();
        this.log('action', `Navigated to: ${frame.url()}`, task.id);
        this.emitUpdate();
      }
    });
  }

  async runBotDetectionTest(task) {
    const testSites = [
      { url: 'https://bot.sannysoft.com/', name: 'Sannysoft Bot Test', checkSelector: 'table' },
      { url: 'https://arh.antoinevastel.com/bots/areyouheadless', name: 'Are You Headless', checkSelector: 'body' },
      { url: 'https://abrahamjuliot.github.io/creepjs/', name: 'CreepJS Fingerprint', checkSelector: '.visitor-info' }
    ];

    let passedTests = 0;
    let totalTests = testSites.length;

    for (const site of testSites) {
      try {
        this.log('action', `Testing: ${site.name}`, task.id);
        await task.page.goto(site.url, { waitUntil: 'networkidle2', timeout: 45000 });
        await this.delay(4000);
        
        const pageContent = await task.page.evaluate(() => document.body.innerText.substring(0, 500));
        
        const screenshot = await task.page.screenshot({ encoding: 'base64' });
        this.io.emit('screenshot', { taskId: task.id, image: screenshot, site: site.name });
        
        const passed = !pageContent.toLowerCase().includes('bot detected') && 
                       !pageContent.toLowerCase().includes('headless: true');
        
        if (passed) {
          passedTests++;
          this.log('success', `Passed: ${site.name}`, task.id);
        } else {
          this.log('warning', `Detected as bot: ${site.name}`, task.id);
        }
      } catch (error) {
        this.log('error', `Failed ${site.name}: ${error.message}`, task.id);
      }
    }
    
    this.log('info', `Bot Detection Results: ${passedTests}/${totalTests} tests passed`, task.id);
  }

  async runCloudflareTest(task) {
    this.log('action', 'Testing Cloudflare challenge pages...', task.id);
    
    const testUrls = [
      { url: 'https://nopecha.com/demo/cloudflare', name: 'Cloudflare WAF Demo' },
      { url: 'https://2captcha.com/demo/cloudflare-turnstile', name: '2Captcha Turnstile Demo' }
    ];
    
    for (const site of testUrls) {
      try {
        this.log('action', `Testing: ${site.name}`, task.id);
        await task.page.goto(site.url, { waitUntil: 'networkidle2', timeout: 45000 });
        
        this.log('info', 'Waiting for page to load and checking for Turnstile...', task.id);
        await this.delay(5000);
        
        const hasTurnstile = await task.page.evaluate(() => {
          return document.querySelector('[name="cf-turnstile-response"]') !== null ||
                 document.querySelector('iframe[src*="challenges.cloudflare.com"]') !== null;
        });
        
        if (hasTurnstile) {
          this.log('info', 'Turnstile detected, waiting for auto-solve...', task.id);
          
          let token = null;
          const startTime = Date.now();
          
          while (!token && (Date.now() - startTime) < 30000) {
            token = await task.page.evaluate(() => {
              try {
                const el = document.querySelector('[name="cf-turnstile-response"]');
                return el && el.value && el.value.length > 20 ? el.value : null;
              } catch (e) {
                return null;
              }
            });
            
            if (!token) {
              await this.delay(1000);
            }
          }
          
          if (token) {
            this.log('success', `Turnstile solved on ${site.name}!`, task.id);
          } else {
            this.log('warning', `Turnstile not solved within timeout on ${site.name}`, task.id);
          }
        } else {
          this.log('info', `No Turnstile on ${site.name}, page loaded successfully`, task.id);
        }
        
        const screenshot = await task.page.screenshot({ encoding: 'base64' });
        this.io.emit('screenshot', { taskId: task.id, image: screenshot, site: site.name });
        
      } catch (error) {
        this.log('error', `${site.name} failed: ${error.message}`, task.id);
      }
    }
  }

  async runFingerprintTest(task) {
    this.log('action', 'Testing Browser Fingerprint...', task.id);
    
    const fingerprintSites = [
      { url: 'https://browserleaks.com/javascript', name: 'BrowserLeaks JS' },
      { url: 'https://pixelscan.net/', name: 'PixelScan' }
    ];
    
    for (const site of fingerprintSites) {
      try {
        this.log('action', `Checking: ${site.name}`, task.id);
        await task.page.goto(site.url, { waitUntil: 'networkidle2', timeout: 45000 });
        await this.delay(5000);
        
        const screenshot = await task.page.screenshot({ encoding: 'base64' });
        this.io.emit('screenshot', { taskId: task.id, image: screenshot, site: site.name });
        
        const pageText = await task.page.evaluate(() => document.body.innerText.substring(0, 1000));
        
        const isSuspicious = pageText.toLowerCase().includes('bot') || 
                            pageText.toLowerCase().includes('automation') ||
                            pageText.toLowerCase().includes('headless');
        
        if (isSuspicious) {
          this.log('warning', `${site.name}: Possible detection flags found`, task.id);
        } else {
          this.log('success', `${site.name}: No obvious detection flags`, task.id);
        }
      } catch (error) {
        this.log('error', `${site.name} failed: ${error.message}`, task.id);
      }
    }
    
    this.log('info', 'Fingerprint analysis complete - check screenshots for details', task.id);
  }
  
  async runFingerprintTestLegacy(task) {
    this.log('action', 'Testing Fingerprint Detection (Legacy)...', task.id);
    
    try {
      await task.page.goto('https://fingerprint.com/products/bot-detection/', { waitUntil: 'networkidle2', timeout: 30000 });
      await this.delay(5000);
      
      const result = await task.page.evaluate(() => {
        const selectors = ['.HeroSection-module--botSubTitle--2711e', '[class*="botSubTitle"]', '[class*="HeroSection"] p'];
        for (const sel of selectors) {
          const el = document.querySelector(sel);
          if (el) return el.textContent;
        }
        return 'Unable to find result element';
      }).catch(() => 'Unable to evaluate');
      
      this.log('info', `Fingerprint result: ${result}`, task.id);
      
      const screenshot = await task.page.screenshot({ encoding: 'base64' });
      this.io.emit('screenshot', { taskId: task.id, image: screenshot, site: 'Fingerprint Bot Detection' });
      
    } catch (error) {
      this.log('error', `Fingerprint test failed: ${error.message}`, task.id);
    }
  }

  async runCustomNavigation(task) {
    const url = task.options.url || 'https://example.com';
    this.log('action', `Navigating to: ${url}`, task.id);
    
    try {
      await task.page.goto(url, { waitUntil: 'networkidle0', timeout: 30000 });
      await this.delay(2000);
      
      const title = await task.page.title();
      this.log('info', `Page title: ${title}`, task.id);
      
      const screenshot = await task.page.screenshot({ encoding: 'base64' });
      this.io.emit('screenshot', { taskId: task.id, image: screenshot, site: url });
      
    } catch (error) {
      this.log('error', `Navigation failed: ${error.message}`, task.id);
    }
  }

  async runWebScraper(task) {
    const url = task.options.url || 'https://quotes.toscrape.com';
    this.log('action', `Web Scraper starting on: ${url}`, task.id);
    
    try {
      await task.page.goto(url, { waitUntil: 'networkidle2', timeout: 45000 });
      await this.delay(3000);
      
      const scrapedData = await task.page.evaluate(() => {
        const data = {
          title: document.title,
          url: window.location.href,
          headings: [],
          links: [],
          images: [],
          text: []
        };
        
        document.querySelectorAll('h1, h2, h3').forEach(h => {
          data.headings.push({ tag: h.tagName, text: h.textContent.trim() });
        });
        
        document.querySelectorAll('a[href]').forEach(a => {
          data.links.push({ text: a.textContent.trim().substring(0, 50), href: a.href });
        });
        
        document.querySelectorAll('img').forEach(img => {
          data.images.push({ src: img.src, alt: img.alt });
        });
        
        document.querySelectorAll('p').forEach(p => {
          const text = p.textContent.trim();
          if (text.length > 20) data.text.push(text.substring(0, 200));
        });
        
        return data;
      });
      
      this.log('success', `Scraped ${scrapedData.headings.length} headings, ${scrapedData.links.length} links, ${scrapedData.images.length} images`, task.id);
      this.log('info', `Data extracted: ${JSON.stringify(scrapedData).substring(0, 500)}...`, task.id);
      
      const screenshot = await task.page.screenshot({ encoding: 'base64' });
      this.io.emit('screenshot', { taskId: task.id, image: screenshot, site: 'Web Scraper Result' });
      
    } catch (error) {
      this.log('error', `Web scraper failed: ${error.message}`, task.id);
    }
  }

  async runFormAutomation(task) {
    const url = task.options.url || 'https://www.selenium.dev/selenium/web/web-form.html';
    this.log('action', `Form Automation starting on: ${url}`, task.id);
    
    try {
      await task.page.goto(url, { waitUntil: 'networkidle2', timeout: 45000 });
      await this.delay(2000);
      
      const forms = await task.page.evaluate(() => {
        const formElements = document.querySelectorAll('input, textarea, select');
        return Array.from(formElements).map(el => ({
          type: el.type || el.tagName.toLowerCase(),
          name: el.name || el.id,
          placeholder: el.placeholder
        }));
      });
      
      this.log('info', `Found ${forms.length} form elements`, task.id);
      
      for (const form of forms) {
        if (form.type === 'text' || form.type === 'email') {
          const selector = form.name ? `[name="${form.name}"]` : `[id="${form.name}"]`;
          try {
            await task.page.type(selector, 'test@example.com', { delay: 50 });
            this.log('action', `Filled: ${form.name}`, task.id);
            await this.delay(500);
          } catch (e) {}
        }
      }
      
      const screenshot = await task.page.screenshot({ encoding: 'base64' });
      this.io.emit('screenshot', { taskId: task.id, image: screenshot, site: 'Form Automation' });
      
      this.log('success', 'Form automation completed', task.id);
      
    } catch (error) {
      this.log('error', `Form automation failed: ${error.message}`, task.id);
    }
  }

  async runSessionRecorder(task) {
    this.log('action', 'Session Recorder starting...', task.id);
    
    const networkRequests = [];
    const consoleMessages = [];
    
    task.page.on('request', request => {
      networkRequests.push({
        url: request.url().substring(0, 100),
        method: request.method(),
        type: request.resourceType()
      });
    });
    
    task.page.on('console', msg => {
      consoleMessages.push({
        type: msg.type(),
        text: msg.text().substring(0, 200)
      });
    });
    
    const testUrl = task.options.url || 'https://httpbin.org/anything';
    
    try {
      await task.page.goto(testUrl, { waitUntil: 'networkidle2', timeout: 45000 });
      await this.delay(3000);
      
      this.log('info', `Captured ${networkRequests.length} network requests`, task.id);
      this.log('info', `Captured ${consoleMessages.length} console messages`, task.id);
      
      const topRequests = networkRequests.slice(0, 10);
      topRequests.forEach(req => {
        this.log('action', `${req.method} ${req.type}: ${req.url}`, task.id);
      });
      
      const screenshot = await task.page.screenshot({ encoding: 'base64' });
      this.io.emit('screenshot', { taskId: task.id, image: screenshot, site: 'Session Recording' });
      
      this.log('success', 'Session recording completed', task.id);
      
    } catch (error) {
      this.log('error', `Session recorder failed: ${error.message}`, task.id);
    }
  }

  async runMultiPageCrawler(task) {
    const startUrl = task.options.url || 'https://quotes.toscrape.com';
    const maxPages = task.options.maxPages || 3;
    
    this.log('action', `Multi-Page Crawler starting at: ${startUrl}`, task.id);
    this.log('info', `Will crawl up to ${maxPages} pages`, task.id);
    
    const visited = new Set();
    const toVisit = [startUrl];
    const results = [];
    
    try {
      while (toVisit.length > 0 && visited.size < maxPages) {
        const url = toVisit.shift();
        if (visited.has(url)) continue;
        
        this.log('action', `Crawling: ${url}`, task.id);
        visited.add(url);
        
        await task.page.goto(url, { waitUntil: 'networkidle2', timeout: 30000 });
        await this.delay(2000);
        
        const pageData = await task.page.evaluate(() => {
          const links = Array.from(document.querySelectorAll('a[href]'))
            .map(a => a.href)
            .filter(href => href.startsWith('http'));
          
          return {
            title: document.title,
            links: links.slice(0, 10)
          };
        });
        
        results.push({ url, title: pageData.title, linksFound: pageData.links.length });
        
        pageData.links.forEach(link => {
          if (!visited.has(link) && link.includes(new URL(startUrl).hostname)) {
            toVisit.push(link);
          }
        });
      }
      
      this.log('success', `Crawled ${visited.size} pages`, task.id);
      results.forEach(r => {
        this.log('info', `${r.title}: ${r.linksFound} links`, task.id);
      });
      
      const screenshot = await task.page.screenshot({ encoding: 'base64' });
      this.io.emit('screenshot', { taskId: task.id, image: screenshot, site: 'Last Crawled Page' });
      
    } catch (error) {
      this.log('error', `Multi-page crawler failed: ${error.message}`, task.id);
    }
  }

  async runScreenshotBatch(task) {
    const urls = task.options.urls || [
      'https://example.com',
      'https://httpbin.org/html',
      'https://quotes.toscrape.com'
    ];
    
    this.log('action', `Batch Screenshots: ${urls.length} URLs to capture`, task.id);
    
    try {
      for (let i = 0; i < urls.length; i++) {
        const url = urls[i];
        this.log('action', `Capturing ${i + 1}/${urls.length}: ${url}`, task.id);
        
        await task.page.goto(url, { waitUntil: 'networkidle2', timeout: 30000 });
        await this.delay(2000);
        
        const screenshot = await task.page.screenshot({ encoding: 'base64' });
        this.io.emit('screenshot', { taskId: task.id, image: screenshot, site: `${i + 1}. ${url}` });
        
        this.log('success', `Captured: ${url}`, task.id);
      }
      
      this.log('success', `All ${urls.length} screenshots captured`, task.id);
      
    } catch (error) {
      this.log('error', `Batch screenshots failed: ${error.message}`, task.id);
    }
  }

  async runPerformanceAudit(task) {
    const url = task.options.url || 'https://example.com';
    this.log('action', `Performance Audit starting on: ${url}`, task.id);
    
    try {
      await task.page.setCacheEnabled(false);
      
      const startTime = Date.now();
      await task.page.goto(url, { waitUntil: 'networkidle0', timeout: 60000 });
      const loadTime = Date.now() - startTime;
      
      const metrics = await task.page.metrics();
      
      const performance = await task.page.evaluate(() => {
        const timing = performance.timing;
        const paint = performance.getEntriesByType('paint');
        
        return {
          domContentLoaded: timing.domContentLoadedEventEnd - timing.navigationStart,
          loadComplete: timing.loadEventEnd - timing.navigationStart,
          firstPaint: paint.find(p => p.name === 'first-paint')?.startTime || 0,
          firstContentfulPaint: paint.find(p => p.name === 'first-contentful-paint')?.startTime || 0,
          resourceCount: performance.getEntriesByType('resource').length
        };
      });
      
      this.log('info', `Total Load Time: ${loadTime}ms`, task.id);
      this.log('info', `DOM Content Loaded: ${performance.domContentLoaded}ms`, task.id);
      this.log('info', `First Paint: ${Math.round(performance.firstPaint)}ms`, task.id);
      this.log('info', `First Contentful Paint: ${Math.round(performance.firstContentfulPaint)}ms`, task.id);
      this.log('info', `Resources Loaded: ${performance.resourceCount}`, task.id);
      this.log('info', `JS Heap Size: ${Math.round(metrics.JSHeapUsedSize / 1024 / 1024)}MB`, task.id);
      
      const rating = loadTime < 2000 ? 'Fast' : loadTime < 5000 ? 'Medium' : 'Slow';
      this.log('success', `Performance Rating: ${rating}`, task.id);
      
      const screenshot = await task.page.screenshot({ encoding: 'base64' });
      this.io.emit('screenshot', { taskId: task.id, image: screenshot, site: 'Performance Audit' });
      
    } catch (error) {
      this.log('error', `Performance audit failed: ${error.message}`, task.id);
    }
  }

  async runCaptchaSolver(task) {
    this.log('action', 'CAPTCHA Solver starting...', task.id);
    
    const testSites = [
      { url: 'https://captcha.com/demos/features/captcha-demo.aspx', name: 'Captcha.com Demo' },
      { url: 'https://www.phpcaptcha.org/try-securimage/', name: 'SecurImage Demo' }
    ];
    
    try {
      for (const site of testSites) {
        this.log('action', `Testing CAPTCHA on: ${site.name}`, task.id);
        
        try {
          await task.page.goto(site.url, { waitUntil: 'networkidle2', timeout: 30000 });
          await this.delay(2000);
          
          const result = await this.captchaSolver.findAndSolveCaptcha(task.page, task.id);
          
          if (result) {
            this.log('success', `CAPTCHA solved: "${result.text}" (${Math.round(result.confidence)}% confidence)`, task.id);
          } else {
            this.log('info', 'No simple CAPTCHA found or unable to solve', task.id);
          }
          
          const screenshot = await task.page.screenshot({ encoding: 'base64' });
          this.io.emit('screenshot', { taskId: task.id, image: screenshot, site: site.name });
          
        } catch (e) {
          this.log('warning', `Could not test ${site.name}: ${e.message}`, task.id);
        }
      }
      
      this.log('success', 'CAPTCHA solver test complete', task.id);
      
    } catch (error) {
      this.log('error', `CAPTCHA solver failed: ${error.message}`, task.id);
    }
  }

  async runRecaptchaV3Test(task) {
    this.log('action', 'reCAPTCHA v3 bypass test starting...', task.id);
    
    const testSites = [
      { url: 'https://www.google.com/recaptcha/api2/demo', name: 'Google reCAPTCHA Demo' },
      { url: 'https://antcpt.com/score_detector/', name: 'reCAPTCHA Score Detector' },
      { url: 'https://recaptcha-demo.appspot.com/recaptcha-v3-request-scores.php', name: 'reCAPTCHA v3 Score Test' }
    ];
    
    try {
      for (const site of testSites) {
        this.log('action', `Testing on: ${site.name}`, task.id);
        
        try {
          await task.page.goto(site.url, { waitUntil: 'networkidle2', timeout: 45000 });
          await this.delay(2000);
          
          const recaptchaInfo = await this.captchaSolver.checkRecaptchaV3Score(task.page, task.id);
          
          if (recaptchaInfo) {
            this.log('info', `reCAPTCHA detected - v2: ${recaptchaInfo.hasV2}, v3: ${recaptchaInfo.hasV3}`, task.id);
            
            if (recaptchaInfo.hasV3) {
              this.log('action', 'Running behavior optimization for v3...', task.id);
              await this.behaviorSimulator.optimizeForRecaptchaV3(task.page, task.id);
            }
          }
          
          const pageContent = await task.page.evaluate(() => document.body.innerText.substring(0, 1000));
          
          const scoreMatch = pageContent.match(/score[:\s]*([0-9.]+)/i);
          if (scoreMatch) {
            const score = parseFloat(scoreMatch[1]);
            if (score >= 0.7) {
              this.log('success', `reCAPTCHA v3 Score: ${score} - PASSED!`, task.id);
            } else if (score >= 0.5) {
              this.log('warning', `reCAPTCHA v3 Score: ${score} - Medium risk`, task.id);
            } else {
              this.log('error', `reCAPTCHA v3 Score: ${score} - Low (detected as bot)`, task.id);
            }
          }
          
          const screenshot = await task.page.screenshot({ encoding: 'base64' });
          this.io.emit('screenshot', { taskId: task.id, image: screenshot, site: site.name });
          
        } catch (e) {
          this.log('warning', `Could not test ${site.name}: ${e.message}`, task.id);
        }
        
        await this.delay(2000);
      }
      
      this.log('success', 'reCAPTCHA v3 testing complete', task.id);
      
    } catch (error) {
      this.log('error', `reCAPTCHA v3 test failed: ${error.message}`, task.id);
    }
  }

  async runBehaviorSimulation(task) {
    const url = task.options.url || 'https://bot.sannysoft.com/';
    const duration = task.options.duration || 15;
    
    this.log('action', `Human Behavior Simulation starting on: ${url}`, task.id);
    this.log('info', `Duration: ${duration} seconds`, task.id);
    
    try {
      await task.page.goto(url, { waitUntil: 'networkidle2', timeout: 45000 });
      await this.delay(2000);
      
      const screenshotBefore = await task.page.screenshot({ encoding: 'base64' });
      this.io.emit('screenshot', { taskId: task.id, image: screenshotBefore, site: 'Before Simulation' });
      
      const actionCount = await this.behaviorSimulator.runFullHumanSimulation(task.page, task.id, duration);
      
      this.log('info', `Performed ${actionCount} human-like actions`, task.id);
      
      const screenshotAfter = await task.page.screenshot({ encoding: 'base64' });
      this.io.emit('screenshot', { taskId: task.id, image: screenshotAfter, site: 'After Simulation' });
      
      const botScore = await task.page.evaluate(() => {
        const results = document.body.innerText;
        const passed = (results.match(/✔|pass|ok|true/gi) || []).length;
        const failed = (results.match(/✘|fail|false|detected/gi) || []).length;
        return { passed, failed };
      });
      
      this.log('success', `Behavior simulation complete. Detection results: ${botScore.passed} passed, ${botScore.failed} warnings`, task.id);
      
    } catch (error) {
      this.log('error', `Behavior simulation failed: ${error.message}`, task.id);
    }
  }

  async cleanupTask(task) {
    try {
      // Stop live streaming for this task
      if (task.streamInterval) {
        clearInterval(task.streamInterval);
        task.streamInterval = null;
      }
      
      if (task.browser) {
        await task.browser.close();
        this.log('info', 'Browser closed', task.id);
      }
    } catch (error) {
      this.log('warning', `Cleanup error: ${error.message}`, task.id);
    }
    
    // Remove task immediately and update browserReady based on remaining active browsers
    this.activeTasks.delete(task.id);
    this.browserReady = Array.from(this.activeTasks.values()).some(t => t.browser !== null);
    this.emitUpdate();
  }

  async stopTask(taskId) {
    const task = this.activeTasks.get(taskId);
    if (!task) {
      throw new Error('Task not found');
    }
    
    this.log('info', 'Stopping task...', taskId);
    task.status = 'stopping';
    
    // Stop live stream immediately before cleanup
    this.stopLiveStream(task);
    
    this.emitUpdate();
    
    try {
      await this.cleanupTask(task);
    } catch (error) {
      this.log('warning', `Error during task cleanup: ${error.message}`, taskId);
      // Ensure task is removed even if cleanup fails
      this.activeTasks.delete(task.id);
      this.browserReady = Array.from(this.activeTasks.values()).some(t => t.browser !== null);
      this.emitUpdate();
    }
  }

  async stopAllTasks() {
    this.log('info', 'Stopping all tasks...');
    const promises = [];
    for (const [id] of this.activeTasks) {
      promises.push(this.stopTask(id).catch(() => {}));
    }
    await Promise.all(promises);
  }

  emitUpdate() {
    this.io.emit('status', {
      status: this.getStatus(),
      activeTasks: this.getActiveTasks()
    });
  }

  startLiveStream(task, intervalMs = 500) {
    // Clear any existing stream for this task
    this.stopLiveStream(task);
    
    let isCapturing = false;
    let consecutiveErrors = 0;
    const maxConsecutiveErrors = 3;
    
    const captureFrame = async () => {
      // Stop conditions - check all exit paths
      if (!task.streamInterval || 
          !task.page || 
          task.status === 'stopping' || 
          task.status === 'completed' || 
          task.status === 'failed') {
        this.stopLiveStream(task);
        return;
      }
      
      // Check if page is closed
      try {
        if (task.page.isClosed()) {
          this.stopLiveStream(task);
          return;
        }
      } catch (e) {
        this.stopLiveStream(task);
        return;
      }
      
      // Skip if already capturing (throttle)
      if (isCapturing) {
        return;
      }
      
      try {
        isCapturing = true;
        const screenshot = await task.page.screenshot({ 
          encoding: 'base64',
          quality: 60, // Lower quality for faster streaming
          type: 'jpeg' // JPEG is faster than PNG
        });
        
        // Only emit if stream is still active
        if (task.streamInterval) {
          this.io.emit('screenshot', { 
            taskId: task.id, 
            image: screenshot, 
            site: 'Live View',
            isLive: true,
            format: 'jpeg'
          });
          stateManager.setLastScreenshot(screenshot, 'Live View', 'automation');
        }
        consecutiveErrors = 0; // Reset on success
      } catch (e) {
        consecutiveErrors++;
        // Stop streaming after too many consecutive errors
        if (consecutiveErrors >= maxConsecutiveErrors) {
          this.stopLiveStream(task);
        }
      } finally {
        isCapturing = false;
      }
    };
    
    task.streamInterval = setInterval(captureFrame, intervalMs);
    this.log('info', 'Live streaming started', task.id);
  }

  stopLiveStream(task) {
    if (task && task.streamInterval) {
      clearInterval(task.streamInterval);
      task.streamInterval = null;
    }
  }

  delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

module.exports = { AutomationEngine };
