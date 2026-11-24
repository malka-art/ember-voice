// Makes the taskbar icons from the bar's own orb, one per state:
//   assets/ember-idle.ico   the orb alone (also assets/ember.png, 256 px)
//   assets/ember-hear.ico   with the bar's listening glow
//   assets/ember-speak.ico  with the bar's speaking glow
// each holding 16, 24, 32, 48 and 256 px images. The glow colours are the
// bar's own (--hear-rgb and --speak-rgb in renderer/style.css).
// Run it again after changing the orb's look:  npx electron scripts/make-icon.mjs
import { app, BrowserWindow } from 'electron';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildIco } from '../lib/ico.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'assets');

// The first (dark theme, :root) value of a colour variable in the bar's styles.
export function barColour(name, css = readFileSync(path.join(ROOT, 'renderer', 'style.css'), 'utf8')) {
  const match = new RegExp(`${name}:\\s*(\\d+,\\s*\\d+,\\s*\\d+)\\s*;`).exec(css);
  if (!match) throw new Error(`${name} is not in renderer/style.css`);
  return match[1];
}

app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, width: 300, height: 300, webPreferences: { sandbox: true, contextIsolation: true } });
  await win.loadFile(path.join(ROOT, 'scripts', 'icon', 'icon.html'), { query: { hear: barColour('--hear-rgb'), speak: barColour('--speak-rgb') } });
  let images = null;
  for (let i = 0; i < 200 && !images; i++) {
    images = await win.webContents.executeJavaScript('window.iconImages || null');
    if (!images) await new Promise((resolve) => setTimeout(resolve, 50));
  }
  if (!images) throw new Error('the icon page did not draw');
  mkdirSync(OUT, { recursive: true });
  for (const [name, bySize] of Object.entries(images)) {
    const pngs = Object.entries(bySize).map(([size, url]) => ({ size: Number(size), png: Buffer.from(url.split(',')[1], 'base64') }));
    writeFileSync(path.join(OUT, `ember-${name}.ico`), buildIco(pngs));
    if (name === 'idle') writeFileSync(path.join(OUT, 'ember.png'), pngs.find((p) => p.size === 256).png);
    if (process.env.EMBER_ICON_PREVIEW) {
      for (const { size, png } of pngs) writeFileSync(path.join(process.env.EMBER_ICON_PREVIEW, `ember-${name}-${size}.png`), png);
    }
    console.log(`wrote ember-${name}.ico`);
  }
  app.quit();
});
