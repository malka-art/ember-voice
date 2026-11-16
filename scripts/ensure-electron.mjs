#!/usr/bin/env node
// On this computer "npm install" did not run Electron's own download step,
// which left the app without its program file. This runs that step when the
// file is missing, so one "npm install" is always enough.

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const electronDir = path.join(root, 'node_modules', 'electron');

if (existsSync(path.join(electronDir, 'install.js')) && !existsSync(path.join(electronDir, 'path.txt'))) {
  console.log('Downloading Electron...');
  const result = spawnSync(process.execPath, [path.join(electronDir, 'install.js')], { stdio: 'inherit' });
  if (result.status !== 0) {
    console.error('Electron could not be downloaded. Run "npm install" again when you are online.');
    process.exit(result.status ?? 1);
  }
}
