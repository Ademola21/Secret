class BehaviorSimulator {
  constructor(engine) {
    this.engine = engine;
  }

  getRandomInt(min, max) {
    return Math.floor(Math.random() * (max - min + 1)) + min;
  }

  getRandomFloat(min, max) {
    return Math.random() * (max - min) + min;
  }

  async delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  async simulateHumanBehavior(page, taskId, options = {}) {
    const {
      duration = 10000,
      scrolls = 3,
      mouseMoves = 5,
      readingPauses = 2
    } = options;

    this.engine.log('action', `Starting human behavior simulation (${duration/1000}s)...`, taskId);

    const startTime = Date.now();
    let actionCount = 0;

    while (Date.now() - startTime < duration) {
      const action = this.getRandomInt(1, 5);

      switch (action) {
        case 1:
          await this.simulateMouseMovement(page, taskId);
          break;
        case 2:
          await this.simulateScroll(page, taskId);
          break;
        case 3:
          await this.simulateReadingPause(taskId);
          break;
        case 4:
          await this.simulateRandomHover(page, taskId);
          break;
        case 5:
          await this.simulateViewportInteraction(page, taskId);
          break;
      }

      actionCount++;
      await this.delay(this.getRandomInt(500, 2000));
    }

    this.engine.log('success', `Behavior simulation complete: ${actionCount} human-like actions performed`, taskId);
    return actionCount;
  }

  async simulateMouseMovement(page, taskId) {
    try {
      const viewport = await page.evaluate(() => ({
        width: window.innerWidth,
        height: window.innerHeight
      }));

      const points = this.getRandomInt(3, 7);
      
      for (let i = 0; i < points; i++) {
        const x = this.getRandomInt(100, viewport.width - 100);
        const y = this.getRandomInt(100, viewport.height - 100);
        
        await page.mouse.move(x, y, {
          steps: this.getRandomInt(10, 25)
        });
        
        await this.delay(this.getRandomInt(50, 200));
      }
      
      this.engine.log('action', 'Mouse movement pattern executed', taskId);
    } catch (e) {
      // Silent fail for mouse movements
    }
  }

  async simulateScroll(page, taskId) {
    try {
      const scrollAmount = this.getRandomInt(100, 400);
      const direction = Math.random() > 0.3 ? 1 : -1;
      
      await page.evaluate((amount) => {
        window.scrollBy({
          top: amount,
          behavior: 'smooth'
        });
      }, scrollAmount * direction);

      await this.delay(this.getRandomInt(300, 800));
      
      this.engine.log('action', `Scrolled ${direction > 0 ? 'down' : 'up'} ${scrollAmount}px`, taskId);
    } catch (e) {
      // Silent fail
    }
  }

  async simulateReadingPause(taskId) {
    const readTime = this.getRandomInt(1000, 3000);
    this.engine.log('action', `Reading pause: ${readTime}ms`, taskId);
    await this.delay(readTime);
  }

  async simulateRandomHover(page, taskId) {
    try {
      const hoverTargets = await page.evaluate(() => {
        const elements = document.querySelectorAll('a, button, input, [role="button"]');
        const visible = [];
        
        elements.forEach((el, i) => {
          if (i < 20) {
            const rect = el.getBoundingClientRect();
            if (rect.width > 0 && rect.height > 0 && rect.top > 0 && rect.top < window.innerHeight) {
              visible.push({
                x: rect.left + rect.width / 2,
                y: rect.top + rect.height / 2
              });
            }
          }
        });
        
        return visible;
      });

      if (hoverTargets.length > 0) {
        const target = hoverTargets[this.getRandomInt(0, hoverTargets.length - 1)];
        await page.mouse.move(target.x, target.y, { steps: 15 });
        await this.delay(this.getRandomInt(200, 500));
        this.engine.log('action', 'Hovered over interactive element', taskId);
      }
    } catch (e) {
      // Silent fail
    }
  }

  async simulateViewportInteraction(page, taskId) {
    try {
      const focusActions = ['focus', 'blur'];
      const action = focusActions[this.getRandomInt(0, 1)];
      
      await page.evaluate((act) => {
        if (act === 'blur') {
          document.activeElement?.blur();
        }
      }, action);
      
      await this.delay(this.getRandomInt(100, 300));
    } catch (e) {
      // Silent fail
    }
  }

  async optimizeForRecaptchaV3(page, taskId) {
    this.engine.log('action', 'Optimizing behavior for reCAPTCHA v3 score...', taskId);

    await this.delay(this.getRandomInt(2000, 4000));
    this.engine.log('info', 'Initial page reading time added', taskId);

    await this.simulateMouseMovement(page, taskId);
    await this.simulateMouseMovement(page, taskId);
    await this.simulateMouseMovement(page, taskId);

    for (let i = 0; i < 3; i++) {
      await this.simulateScroll(page, taskId);
      await this.delay(this.getRandomInt(500, 1500));
    }

    await page.evaluate(() => {
      window.scrollTo({ top: 0, behavior: 'smooth' });
    });
    await this.delay(1000);

    await this.simulateRandomHover(page, taskId);
    await this.simulateRandomHover(page, taskId);

    await this.simulateReadingPause(taskId);

    this.engine.log('success', 'reCAPTCHA v3 optimization complete - should have high trust score', taskId);
    
    return true;
  }

  async simulateFormFilling(page, taskId, formData = {}) {
    this.engine.log('action', 'Simulating human form filling...', taskId);

    const inputs = await page.$$('input[type="text"], input[type="email"], input[type="password"], textarea');
    
    for (const input of inputs) {
      try {
        const inputInfo = await input.evaluate(el => ({
          type: el.type,
          name: el.name,
          placeholder: el.placeholder
        }));

        await input.click();
        await this.delay(this.getRandomInt(200, 500));

        const testValue = formData[inputInfo.name] || 'test@example.com';
        
        for (const char of testValue) {
          await input.type(char, { delay: this.getRandomInt(50, 150) });
          
          if (Math.random() > 0.9) {
            await this.delay(this.getRandomInt(200, 500));
          }
        }

        await this.delay(this.getRandomInt(300, 800));
        
        this.engine.log('action', `Filled field: ${inputInfo.name || inputInfo.placeholder || 'unknown'}`, taskId);
      } catch (e) {
        continue;
      }
    }

    this.engine.log('success', 'Form filling simulation complete', taskId);
  }

  async runFullHumanSimulation(page, taskId, durationSeconds = 15) {
    this.engine.log('action', `Running full human simulation for ${durationSeconds} seconds...`, taskId);

    const actions = [
      () => this.simulateMouseMovement(page, taskId),
      () => this.simulateScroll(page, taskId),
      () => this.simulateReadingPause(taskId),
      () => this.simulateRandomHover(page, taskId)
    ];

    const startTime = Date.now();
    const duration = durationSeconds * 1000;
    let totalActions = 0;

    while (Date.now() - startTime < duration) {
      const randomAction = actions[this.getRandomInt(0, actions.length - 1)];
      await randomAction();
      totalActions++;
      await this.delay(this.getRandomInt(800, 2000));
    }

    this.engine.log('success', `Full simulation complete: ${totalActions} actions over ${durationSeconds}s`, taskId);
    return totalActions;
  }
}

module.exports = { BehaviorSimulator };
