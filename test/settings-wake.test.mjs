// Tests for the awake/asleep signal and the saved settings.
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { cleanSettings, effectiveSettings, readSettings, updateSettings, VOICE_CHOICES } from '../lib/settings.mjs';
import { createWakeGate } from '../lib/wake.mjs';
import { createWakeWatch } from '../lib/wake-state.mjs';

// A clock and timers the test moves by hand.
function fakeTime() {
  let t = 1000;
  const timers = new Map();
  let next = 1;
  return {
    now: () => t,
    setTimer: (fn, ms) => {
      timers.set(next, { fn, at: t + ms });
      return next++;
    },
    clearTimer: (id) => timers.delete(id),
    advance(ms) {
      t += ms;
      for (const [id, timer] of [...timers]) {
        if (timer.at <= t) {
          timers.delete(id);
          timer.fn();
        }
      }
    },
    pending: () => timers.size,
  };
}

test('wake state: starts asleep, wakes on the name, sleeps when the window runs out', () => {
  const time = fakeTime();
  const gate = createWakeGate({ word: 'ember', followMs: 15000 });
  const seen = [];
  const watch = createWakeWatch({ gate: () => gate, onChange: (s) => seen.push(s), ...time });
  watch.update();
  assert.deepEqual(seen, [{ awake: false, remainingMs: 0 }]);
  assert.equal(time.pending(), 0, 'no timer while asleep');

  // Noise without the name: still asleep, nothing new to report.
  gate.check('what is for dinner', time.now());
  watch.update();
  assert.equal(seen.length, 1);

  gate.check('Ember, what time is it', time.now());
  watch.update();
  assert.deepEqual(seen.at(-1), { awake: true, remainingMs: 15000 });

  // An exchange keeps it open: the new length is reported.
  time.advance(10000);
  gate.touch(time.now());
  watch.update();
  assert.deepEqual(seen.at(-1), { awake: true, remainingMs: 15000 });

  time.advance(14000);
  assert.equal(seen.at(-1).awake, true);
  time.advance(2000);
  assert.deepEqual(seen.at(-1), { awake: false, remainingMs: 0 }, 'the timer put it to sleep by itself');
  assert.equal(time.pending(), 0);
});

test('wake state: with no wake word it is always awake, with no timer', () => {
  const time = fakeTime();
  const seen = [];
  const watch = createWakeWatch({ gate: () => createWakeGate({ word: '' }), onChange: (s) => seen.push(s), ...time });
  watch.update();
  assert.deepEqual(seen, [{ awake: true, remainingMs: null }]);
  assert.equal(time.pending(), 0);
  watch.update();
  assert.equal(seen.length, 1, 'no repeat while nothing changes');
});

test('wake state: replacing the gate (wake word turned off) wakes it at once', () => {
  const time = fakeTime();
  let gate = createWakeGate({ word: 'ember' });
  const seen = [];
  const watch = createWakeWatch({ gate: () => gate, onChange: (s) => seen.push(s), ...time });
  watch.update();
  gate = createWakeGate({ word: '' });
  watch.update();
  assert.deepEqual(seen.map((s) => s.awake), [false, true]);
});

test('settings: unknown keys and bad values are dropped, speed snaps to the slider', () => {
  assert.deepEqual(cleanSettings({ ttsVoice: 'nobody', ttsSpeed: 9, wakeFollowMs: 12345, theme: 'neon', extra: 1 }), { ttsSpeed: 1.6 });
  assert.deepEqual(cleanSettings({ ttsSpeed: 1.27 }), { ttsSpeed: 1.25 });
  assert.deepEqual(cleanSettings({ ttsSpeed: 0.1 }), { ttsSpeed: 0.8 });
  assert.deepEqual(cleanSettings({ wakeWordOn: false, theme: 'system', wakeFollowMs: 30000, ttsVoice: 'bf_emma' }), {
    wakeWordOn: false,
    theme: 'system',
    wakeFollowMs: 30000,
    ttsVoice: 'bf_emma',
  });
  assert.equal(VOICE_CHOICES.length, 10);
});

test('settings: saved choices survive a restart and sit on top of config.json', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'ember-settings-'));
  const file = path.join(dir, 'sub', 'settings.json');
  const config = { ttsVoice: 'af_heart', ttsSpeed: 1.3, wakeWord: 'ember', wakeFollowMs: 15000 };

  assert.deepEqual(readSettings(file), {}, 'no file yet');
  assert.deepEqual(effectiveSettings(config, {}), { ttsVoice: 'af_heart', ttsSpeed: 1.3, wakeFollowMs: 15000, wakeWordOn: true, wakeWord: 'ember', theme: 'dark' });

  let now = updateSettings(file, config, { ttsVoice: 'am_michael' });
  now = updateSettings(file, config, { ttsSpeed: 1.45, theme: 'light' });
  assert.equal(now.ttsVoice, 'am_michael', 'an earlier choice is kept when another is changed');
  assert.ok(existsSync(file));
  assert.ok(!existsSync(`${file}.tmp`));

  // "Restart": read it back from disk.
  const after = effectiveSettings(config, readSettings(file));
  assert.deepEqual(after, { ttsVoice: 'am_michael', ttsSpeed: 1.45, wakeFollowMs: 15000, wakeWordOn: true, wakeWord: 'ember', theme: 'light' });
  assert.equal(config.ttsVoice, 'af_heart', 'config itself is untouched');

  // A damaged file is ignored rather than breaking the bar.
  writeFileSync(file, '{ not json');
  assert.deepEqual(readSettings(file), {});
  assert.match(readFileSync(file, 'utf8'), /not json/);
});
