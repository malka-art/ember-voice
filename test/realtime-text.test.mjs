// Real-time fixes from the November review: hearing, sending, logging and
// keeping the bar on top. Each test is named after the problem it guards.
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createTopKeeper, taskbarTitle, wireTaskbarReturn } from '../lib/keep-on-top.mjs';
import { TASKBAR_ICONS, taskbarIconFor } from '../lib/taskbar-icon.mjs';
import { shouldListen } from '../lib/listen-policy.mjs';
import { createLogFile } from '../lib/log-file.mjs';
import { createSerialQueue } from '../lib/serial.mjs';
import { buildSpeechHint } from '../lib/speech-hint.mjs';
import { cleanTranscript, collapseLoops } from '../lib/stt.mjs';
import { createWakeGate, isFillerOnly, stopLooking } from '../lib/wake.mjs';

test('regr_mic_closed_while_transcribing: the bar keeps listening while the last sentence becomes text', () => {
  const idle = { connected: true, micOn: true, midTurn: true, turnActive: false, speaking: false, error: '' };
  // The window sets `transcribing` for that moment; it must not close the mic.
  assert.equal(shouldListen({ ...idle, transcribing: true }), true);
  assert.equal(shouldListen({ ...idle, micOn: false }), false);
  assert.equal(shouldListen({ ...idle, error: 'x' }), false);
  // Half-duplex modes still wait for their turn.
  assert.equal(shouldListen({ ...idle, midTurn: false, turnActive: true }), false);
  assert.equal(shouldListen({ ...idle, midTurn: false, speaking: true }), false);
});

test('regr_mic_closed_while_transcribing: sentences said back to back reach the thread in order', async () => {
  const run = createSerialQueue();
  const order = [];
  const slow = (name, ms) => () =>
    new Promise((resolve) =>
      setTimeout(() => {
        order.push(name);
        resolve(name);
      }, ms),
    );
  const failing = () => Promise.reject(new Error('could not hear'));
  const results = await Promise.allSettled([run(slow('first', 40)), run(failing), run(slow('second', 1))]);
  assert.deepEqual(order, ['first', 'second']);
  assert.equal(results[1].status, 'rejected', 'a failure is reported, and does not stop the next one');
});

test('regr_whisper_loop: a sentence Whisper repeats over and over is sent once', () => {
  const loop = Array(6).fill('I would like to check out the project.').join(' ');
  assert.equal(cleanTranscript(loop), 'I would like to check out the project.');
  const tail = `Ember, read me the plan. ${Array(5).fill('I am going to tell you about your own life.').join(' ')}`;
  assert.equal(cleanTranscript(tail), 'Ember, read me the plan. I am going to tell you about your own life.');
});

test('regr_whisper_loop: ordinary repetition is left alone', () => {
  assert.equal(collapseLoops('No, no, that is not it.'), 'No, no, that is not it.');
  assert.equal(collapseLoops('Run it. Run it.'), 'Run it. Run it.');
  assert.equal(collapseLoops('It is very very very good'), 'It is very very very good');
  assert.equal(collapseLoops('the the the the end'), 'the end');
});

test('regr_sound_tags: sound labels are dropped wherever they appear', () => {
  assert.equal(cleanTranscript('*Bird noises* *Bird noises*'), '');
  assert.equal(cleanTranscript('Open the file [BLANK_AUDIO] please.'), 'Open the file please.');
  assert.equal(cleanTranscript('(upbeat music) Ember, what time is it?'), 'Ember, what time is it?');
  assert.equal(cleanTranscript('♪ ♪'), '');
  // Your own brackets with capitals stay.
  assert.equal(cleanTranscript('Call it Version Two (Final).'), 'Call it Version Two (Final).');
});

test('regr_filler_messages: "Um," and a lone "but" are not sent as messages', () => {
  for (const text of ['Um,', 'but', 'Hmm. So', 'Uh, and']) assert.equal(isFillerOnly(text), true, text);
  for (const text of ['But why?', 'So run it.', 'Yes', 'No.', 'Gantt, G-A-P.']) assert.equal(isFillerOnly(text), false, text);
  assert.equal(isFillerOnly(''), false);
});

test('regr_partial_flood: asleep, a sentence without the name stops being looked at', () => {
  const gate = createWakeGate({ word: 'ember' });
  const look = (text) => stopLooking(gate.peek(text, 0), text);
  assert.equal(look('so I was'), true, 'three words in, no name: stop');
  assert.equal(look('so I'), false, 'too early to tell');
  assert.equal(look('Ember, what is'), false, 'its name');
  assert.equal(look('Hey Ember can you'), false);
  const open = createWakeGate({ word: 'ember', followMs: 5000 });
  open.touch(0);
  assert.equal(stopLooking(open.peek('and another thing', 1000), 'and another thing'), false, 'awake: keep showing the words');
});

test('regr_log_wiped: a full log is kept as ember.log.1, not emptied', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'ember-log-'));
  try {
    writeFileSync(path.join(dir, 'ember.log'), 'old day\n'.repeat(200));
    const log = createLogFile(dir, { maxBytes: 1000, checkEvery: 5 });
    log.write('first new line\n');
    assert.match(readFileSync(path.join(dir, 'ember.log.1'), 'utf8'), /old day/);
    assert.equal(readFileSync(path.join(dir, 'ember.log'), 'utf8'), 'first new line\n');
    // A bar open for days rolls over too, not only at start.
    for (let i = 0; i < 60; i++) log.write(`line ${i} ${'x'.repeat(30)}\n`);
    assert.ok(readFileSync(path.join(dir, 'ember.log'), 'utf8').length < 1000 + 300);
    assert.ok(existsSync(path.join(dir, 'ember.log.1')));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

function fakeWindow() {
  const calls = [];
  return {
    calls,
    isDestroyed: () => false,
    setAlwaysOnTop: (...args) => calls.push(['setAlwaysOnTop', ...args]),
    showInactive: () => calls.push(['showInactive']),
    moveTop: () => calls.push(['moveTop']),
  };
}

test('regr_bar_slips_behind: after unlock or a screen change it comes back to the front', () => {
  const win = fakeWindow();
  const lines = [];
  const keeper = createTopKeeper({ getWin: () => win, onLog: (line) => lines.push(line) });
  keeper.poke('the PC was unlocked');
  assert.deepEqual(win.calls, [['setAlwaysOnTop', true, 'floating'], ['showInactive'], ['moveTop']]);
  assert.match(lines[0], /unlocked/);
  const gone = createTopKeeper({ getWin: () => null });
  assert.doesNotThrow(() => gone.poke('x'));
});

test('regr_bar_slips_behind: clicking its taskbar button brings it back, and never minimises it', () => {
  const win = fakeWindow();
  const handlers = {};
  win.on = (name, fn) => (handlers[name] = fn);
  win.restore = () => win.calls.push(['restore']);
  wireTaskbarReturn(win);
  // Behind other windows: the click activates it, and it goes to the very front.
  handlers.focus();
  assert.deepEqual(win.calls, [['setAlwaysOnTop', true, 'floating'], ['showInactive'], ['moveTop']]);
  // Already in front: the click would minimise it; it stays up instead.
  win.calls.length = 0;
  handlers.minimize();
  assert.deepEqual(win.calls[0], ['restore']);
  assert.deepEqual(win.calls.at(-1), ['moveTop']);
});

test('regr_bar_slips_behind: each taskbar button is named after its thread', () => {
  assert.equal(taskbarTitle('Catalina'), 'Ember, Catalina');
  assert.equal(taskbarTitle(''), 'Ember');
});

test('regr_misheard_names: your own words are given to the speech model', () => {
  assert.equal(buildSpeechHint(['ember'], ['illi', 'Pulse']), 'Ember, illi, Pulse.');
  assert.equal(buildSpeechHint(['ember', 'juniper'], []), 'Ember, Juniper.');
  assert.equal(buildSpeechHint([], undefined), '');
  // Repeats are dropped and the hint stays short.
  assert.equal(buildSpeechHint(['ember'], ['Ember', 'illi', 'illi']), 'Ember, illi.');
  const many = Array.from({ length: 200 }, (_, i) => `word${i}`);
  assert.ok(buildSpeechHint([], many).length <= 400);
});

test('taskbar icon: each state has a .ico with the orb at every taskbar size', async () => {
  const { buildIco } = await import('../lib/ico.mjs');
  for (const name of TASKBAR_ICONS) {
    const ico = readFileSync(new URL(`../assets/ember-${name}.ico`, import.meta.url));
    assert.equal(ico.readUInt16LE(2), 1, `${name} is an icon file`);
    const sizes = [];
    for (let i = 0; i < ico.readUInt16LE(4); i++) {
      const entry = 6 + 16 * i;
      sizes.push(ico.readUInt8(entry) || 256);
      const at = ico.readUInt32LE(entry + 12);
      assert.equal(ico.subarray(at, at + 4).toString('latin1'), 'PNG', `${name} entry ${i} is a PNG`);
    }
    // 42 px is the taskbar size at 175% scaling (24 x 1.75).
    assert.deepEqual(sizes, [16, 20, 24, 30, 32, 36, 40, 42, 48, 64, 256]);
  }
  const made = buildIco([{ size: 16, png: Buffer.from('PNGfake', 'latin1') }]);
  assert.equal(made.readUInt32LE(6 + 12), 22);
});

test('taskbar icon: yellow glow while you talk, pink while it speaks, none otherwise', () => {
  assert.equal(taskbarIconFor('listening'), 'hear');
  assert.equal(taskbarIconFor('transcribing'), 'hear');
  assert.equal(taskbarIconFor('speaking'), 'speak');
  for (const state of ['idle', 'thinking', 'muted', 'starting', 'error', 'signedout']) assert.equal(taskbarIconFor(state), 'idle', state);
});

test('regr_pink_flash: a held reply waits until the sentence is text, and is dropped if it was sent', async () => {
  const { heldReplyAfterSentence } = await import('../lib/held-reply.mjs');
  assert.equal(heldReplyAfterSentence({ sentToThread: true, stillTalking: false }), 'drop');
  assert.equal(heldReplyAfterSentence({ sentToThread: false, stillTalking: true }), 'keep');
  assert.equal(heldReplyAfterSentence({ sentToThread: false, stillTalking: false }), 'speak');
});

test('taskbar icon: the orb fills the whole icon in every state; the glow lies over its rim', () => {
  const draw = readFileSync(new URL('../scripts/icon/draw.js', import.meta.url), 'utf8');
  assert.match(draw, /const ORB_SHARE = 1;/);
  assert.doesNotMatch(draw, /orbShare\(size/);
});
