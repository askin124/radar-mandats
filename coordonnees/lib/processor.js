const path = require('path');

// One separate browser for the application; never uses the user's browser profile.
class Processor {
  constructor({ profileDir, onProgress, onResult }) {
    Object.assign(this, { profileDir, onProgress, onResult });
    this.context = null;
    this.page = null;
  }
  async open(visible = false) {
    if (this.context && this.page && !this.page.isClosed() && this.visible === visible) return;
    await this.close();
    this.visible = visible;
    const { chromium } = require('playwright');
    // PagesBlanches rejects Chromium's real headless mode. Keep a normal
    // browser engine, but place its dedicated window outside the desktop.
    const options = {
      headless: false,
      viewport: { width: 1280, height: 900 },
      args: visible ? [] : ['--window-position=-10000,-10000', '--window-size=1280,900']
    };
    try {
      this.context = await chromium.launchPersistentContext(this.profileDir, { ...options, channel: 'chrome' });
    } catch (error) {
      try {
        this.context = await chromium.launchPersistentContext(this.profileDir, options);
      } catch {
        throw new Error('Impossible d’ouvrir le navigateur. Installez Google Chrome ou exécutez « npx playwright install chromium », puis reprenez le traitement.');
      }
    }
    this.page = this.context.pages()[0] || await this.context.newPage();
    this.page.setDefaultTimeout(15000);
    await this.setWindowVisible(visible);
  }
  async collect(row, shouldStop, { visible = false } = {}) {
    await this.open(visible);
    if (shouldStop()) throw new Error('PAUSED');
    const page = this.page;
    this.onProgress('Ouverture de la recherche');
    // On a visible verification pause, reuse the page the person has just checked.
    // Do not immediately replace it with the same failed navigation.
    if (!visible || !row.id || this.currentRowId !== row.id) {
      let response;
      try {
        response = await page.goto(row.sourceUrl, { waitUntil: 'domcontentloaded', timeout: 45000 });
        this.currentRowId = row.id;
      } catch (error) {
        if (shouldStop()) throw new Error('PAUSED');
        throw new Error('La page de recherche ne répond pas. Vérifiez votre connexion puis reprenez.');
      }
      if (response && [401, 403, 429].includes(response.status())) {
        if (response.status() !== 429) await this.setWindowVisible(true);
        throw this.accessError(response.status() === 429 ? visible : true, response.status());
      }
      if (response && response.status() >= 400) {
        throw new Error(`Le site de recherche est indisponible (erreur ${response.status()}). Les résultats sont conservés.`);
      }
    }
    await page.addScriptTag({ path: path.join(__dirname, 'page-reader.js') });
    const check = async () => {
      if (shouldStop()) throw new Error('PAUSED');
      const status = await page.evaluate(() => window.pbReader.pageState());
      if (status === 'blocked') {
        await this.setWindowVisible(true);
        throw this.accessError(true);
      }
      return status;
    };
    let cards = [];
    for (let n = 0; n < 30; n++) {
      const status = await check();
      cards = await page.evaluate(() => window.pbReader.scan());
      if (cards.length) break;
      if (status === 'empty') return [];
      await new Promise(resolve => setTimeout(resolve, 500));
    }
    if (!cards.length) {
      await this.setWindowVisible(true);
      throw this.accessError(true, null, true);
    }
    const processed = new Set();
    const results = [];
    let stable = 0;
    while (stable < 3) {
      await check();
      cards = await page.evaluate(() => window.pbReader.scan());
      const card = cards.find(item => item.id && !processed.has(item.id));
      if (!card) {
        stable++;
        await new Promise(resolve => setTimeout(resolve, 500));
        continue;
      }
      stable = 0;
      this.onProgress(`Lecture des contacts · ${processed.size + 1} / ${Math.max(cards.length, processed.size + 1)}`);
      const clicked = await page.evaluate(id => window.pbReader.reveal(id), card.id);
      let live = card;
      if (clicked) {
        for (let n = 0; n < 24; n++) {
          await check();
          const scanned = await page.evaluate(() => window.pbReader.scan());
          live = scanned.find(item => item.id === card.id) || live;
          if (live.phone) break;
          await new Promise(resolve => setTimeout(resolve, 500));
        }
      }
      const { id, status, ...result } = live;
      if (result.fullName || result.phone || result.address) {
        results.push(result);
        this.onResult(result);
      }
      processed.add(card.id);
    }
    return results;
  }
  accessError(visible, httpStatus = null, unrecognized = false) {
    const message = httpStatus === 429
      ? 'Le site limite les recherches. Attendez avant de reprendre.'
      : visible
        ? 'Vérifiez la fenêtre Chrome ouverte : le site peut demander une validation ou un consentement. Après cette étape, cliquez sur Reprendre.'
        : unrecognized
          ? 'Impossible de lire les résultats en mode invisible. Reprenez avec Chrome pour vérifier la page.'
          : 'PagesBlanches refuse la recherche en mode invisible. Reprenez avec Chrome pour continuer sans extension.';
    const error = new Error(message);
    error.code = httpStatus === 429 ? 'RATE_LIMITED' : visible ? 'VERIFICATION_REQUIRED' : 'BROWSER_REQUIRED';
    error.httpStatus = httpStatus;
    return error;
  }
  async setWindowVisible(visible) {
    if (!this.context || !this.page || this.page.isClosed()) return;
    try {
      this.cdp = this.cdp || await this.context.newCDPSession(this.page);
      const { windowId } = await this.cdp.send('Browser.getWindowForTarget');
      await this.cdp.send('Browser.setWindowBounds', {
        windowId,
        bounds: visible
          ? { left: 80, top: 80, width: 1280, height: 900, windowState: 'normal' }
          : { left: -10000, top: -10000, width: 1280, height: 900, windowState: 'normal' }
      });
      this.visible = visible;
    } catch {
      // The launch position still hides the window on platforms where CDP
      // cannot change native window bounds.
      this.visible = visible;
    }
  }
  async close() {
    const context = this.context;
    this.context = null;
    this.page = null;
    this.currentRowId = null;
    this.cdp = null;
    if (context) await context.close().catch(() => {});
  }
}
module.exports = { Processor };
