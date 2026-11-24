// The bar's running log, %APPDATA%\ember-voice\ember.log.
//
// When it grows past `maxBytes` it is moved to ember.log.1 (replacing the one
// before) and a fresh one starts. It used to be emptied instead, which threw
// away the very days a review of the bar needs to look at.
import { appendFileSync, mkdirSync, renameSync, rmSync, statSync } from 'node:fs';
import path from 'node:path';

export function createLogFile(dir, { maxBytes = 1024 * 1024, checkEvery = 200 } = {}) {
  const file = path.join(dir, 'ember.log');
  let lines = 0;
  let ready = false;

  function rotateIfBig() {
    let size = 0;
    try {
      size = statSync(file).size;
    } catch {
      return;
    }
    if (size <= maxBytes) return;
    const old = `${file}.1`;
    try {
      rmSync(old, { force: true });
      renameSync(file, old);
    } catch {
      // Another bar moved it first; it writes to the fresh one too.
    }
  }

  return {
    file,
    write(text) {
      if (!ready) {
        mkdirSync(dir, { recursive: true });
        rotateIfBig();
        ready = true;
      }
      // Bars stay open for days: look at the size now and then, not only at start.
      lines += 1;
      if (lines % checkEvery === 0) rotateIfBig();
      appendFileSync(file, text);
    },
  };
}
