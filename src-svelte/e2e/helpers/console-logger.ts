import { Page } from '@playwright/test';
import fs from 'fs';

const LOG_FILE = 'e2e/playwright-logs.txt';

export function clearLog() {
  try { fs.unlinkSync(LOG_FILE); } catch { /* ignore */ }
}

export function captureConsoleLogs(page: Page) {
  const logs: string[] = [];
  page.on('console', (msg) => {
    const text = `[${msg.type().toUpperCase()}] ${msg.text()}`;
    logs.push(text);
    fs.appendFileSync(LOG_FILE, text + '\n');
  });
  page.on('pageerror', (err) => {
    const text = `[PAGE_ERROR] ${err.message}`;
    logs.push(text);
    fs.appendFileSync(LOG_FILE, text + '\n');
  });
  return logs;
}
