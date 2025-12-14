const Tesseract = require('tesseract.js');
const path = require('path');
const fs = require('fs');

class CaptchaSolver {
  constructor(engine) {
    this.engine = engine;
    this.ocrWorker = null;
    this.ocrInitializing = false;
    
    // Cleanup OCR worker on process exit
    process.on('beforeExit', () => this.cleanup());
    process.on('SIGINT', () => this.cleanup());
    process.on('SIGTERM', () => this.cleanup());
  }

  async initOCR() {
    if (this.ocrWorker) {
      return this.ocrWorker;
    }
    
    if (this.ocrInitializing) {
      while (this.ocrInitializing) {
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      return this.ocrWorker;
    }
    
    try {
      this.ocrInitializing = true;
      this.engine.log('info', 'Initializing Tesseract OCR engine (this may take a moment)...');
      
      this.ocrWorker = await Tesseract.createWorker('eng', 1, {
        logger: m => {
          if (m.status === 'recognizing text' && m.progress) {
            // Progress updates during OCR - silent
          }
        }
      });
      
      this.engine.log('success', 'OCR engine ready');
      return this.ocrWorker;
    } catch (error) {
      this.engine.log('error', `Failed to initialize OCR: ${error.message}`);
      throw error;
    } finally {
      this.ocrInitializing = false;
    }
  }

  async solveImageCaptcha(imageSource, taskId) {
    try {
      this.engine.log('action', 'Attempting to solve image CAPTCHA...', taskId);
      
      const worker = await this.initOCR();
      
      const result = await worker.recognize(imageSource);
      
      const cleanedText = result.data.text
        .replace(/[^a-zA-Z0-9]/g, '')
        .trim()
        .toUpperCase();
      
      this.engine.log('success', `OCR Result: "${cleanedText}" (confidence: ${Math.round(result.data.confidence)}%)`, taskId);
      
      return {
        text: cleanedText,
        confidence: result.data.confidence,
        rawText: result.data.text
      };
    } catch (error) {
      this.engine.log('error', `OCR failed: ${error.message}`, taskId);
      return null;
    }
  }

  async findAndSolveCaptcha(page, taskId) {
    this.engine.log('action', 'Searching for CAPTCHA elements...', taskId);
    
    const captchaSelectors = [
      'img[src*="captcha"]',
      'img[id*="captcha"]',
      'img[class*="captcha"]',
      'img[alt*="captcha"]',
      'canvas[id*="captcha"]',
      '.captcha-image img',
      '#captcha img',
      'img[src*="verify"]'
    ];
    
    for (const selector of captchaSelectors) {
      try {
        const element = await page.$(selector);
        if (element) {
          this.engine.log('info', `Found CAPTCHA element: ${selector}`, taskId);
          
          const screenshot = await element.screenshot({ encoding: 'base64' });
          const imageBuffer = Buffer.from(screenshot, 'base64');
          
          const result = await this.solveImageCaptcha(imageBuffer, taskId);
          
          if (result && result.confidence > 60) {
            const inputSelectors = [
              'input[name*="captcha"]',
              'input[id*="captcha"]',
              'input[class*="captcha"]',
              'input[placeholder*="captcha"]',
              'input[type="text"][name*="code"]',
              'input[type="text"][name*="verify"]'
            ];
            
            for (const inputSel of inputSelectors) {
              const input = await page.$(inputSel);
              if (input) {
                await input.type(result.text, { delay: 100 });
                this.engine.log('success', `Entered CAPTCHA solution: ${result.text}`, taskId);
                return result;
              }
            }
          }
          
          return result;
        }
      } catch (e) {
        continue;
      }
    }
    
    this.engine.log('info', 'No simple CAPTCHA found on page', taskId);
    return null;
  }

  async checkRecaptchaV3Score(page, taskId) {
    this.engine.log('action', 'Checking reCAPTCHA v3 presence...', taskId);
    
    const hasRecaptcha = await page.evaluate(() => {
      return typeof grecaptcha !== 'undefined' || 
             document.querySelector('script[src*="recaptcha"]') !== null ||
             document.querySelector('.g-recaptcha') !== null;
    });
    
    if (hasRecaptcha) {
      this.engine.log('info', 'reCAPTCHA detected on page', taskId);
      
      const recaptchaInfo = await page.evaluate(() => {
        const info = {
          hasV2: false,
          hasV3: false,
          siteKey: null
        };
        
        const v2Element = document.querySelector('.g-recaptcha');
        if (v2Element) {
          info.hasV2 = true;
          info.siteKey = v2Element.getAttribute('data-sitekey');
        }
        
        const scripts = document.querySelectorAll('script[src*="recaptcha"]');
        scripts.forEach(script => {
          if (script.src.includes('v3')) {
            info.hasV3 = true;
          }
        });
        
        if (typeof grecaptcha !== 'undefined' && !info.hasV2) {
          info.hasV3 = true;
        }
        
        return info;
      });
      
      if (recaptchaInfo.hasV3) {
        this.engine.log('success', 'reCAPTCHA v3 detected - behavior simulation will help pass!', taskId);
      }
      if (recaptchaInfo.hasV2) {
        this.engine.log('warning', 'reCAPTCHA v2 detected - requires manual/service solving', taskId);
      }
      
      return recaptchaInfo;
    }
    
    this.engine.log('info', 'No reCAPTCHA found on page', taskId);
    return null;
  }

  async cleanup() {
    if (this.ocrWorker) {
      await this.ocrWorker.terminate();
      this.ocrWorker = null;
    }
  }
}

module.exports = { CaptchaSolver };
