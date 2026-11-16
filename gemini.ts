import { chromium } from 'playwright-core';
import { addLog } from './logger.js';

export async function askGeminiWeb(promptText: string): Promise<string> {
  addLog('🌐 Connexion au port 9222 de Chrome pour Gemini Web...');
  const browser = await chromium.connectOverCDP(
    process.env.CHROME_CDP_URL || 'http://127.0.0.1:9222'
  );

  try {
    const contexts = browser.contexts();
    let geminiPage = null;

    for (const ctx of contexts) {
      for (const page of ctx.pages()) {
        if (page.url().includes('gemini.google.com')) {
          geminiPage = page;
          break;
        }
      }
    }

    if (!geminiPage) {
      const ctx = contexts[0] || (await browser.newContext());
      geminiPage = await ctx.newPage();
      await geminiPage.goto('https://gemini.google.com/app', { waitUntil: 'domcontentloaded' });
    }

    await geminiPage.bringToFront();
    const inputBox = geminiPage.locator('div[contenteditable="true"]').first();
    await inputBox.waitFor({ state: 'visible', timeout: 10000 });
    await inputBox.click();

    await geminiPage.evaluate((text) => {
      document.execCommand('insertText', false, text);
    }, promptText);

    await geminiPage.waitForTimeout(300);
    await geminiPage.keyboard.press('Enter');

    await geminiPage.waitForTimeout(2500);
    const stopButton = geminiPage.locator(
      'button[aria-label*="Stop"], button[aria-label*="Arrêter"]'
    );
    if ((await stopButton.count()) > 0) {
      await stopButton.waitFor({ state: 'hidden', timeout: 120000 });
    }

    const responses = geminiPage.locator('message-content, .model-response-text');
    const count = await responses.count();
    if (count > 0) {
      return await responses.nth(count - 1).innerText();
    }

    return 'Réponse générée dans Gemini, mais texte non extrait.';
  } finally {
    await browser.close();
  }
}
