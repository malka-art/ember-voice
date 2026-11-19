import { app, BrowserWindow, ipcMain, Menu, powerMonitor, screen, session as electronSession } from 'electron';
import { spawn } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, watch, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { bringToFront } from './lib/bring-to-front.mjs';
import { ClaudeBridge } from './lib/claude-bridge.mjs';
import { loadConfig } from './lib/config.mjs';
import { createSpokenMemory } from './lib/echo.mjs';
import { MockBridge } from './lib/mock-bridge.mjs';
import { findSessionFile, parseArgs, recentSessions, resolveTarget, sessionTitle } from './lib/sessions.mjs';
import { isNeuralEngine, loadNeuralVoice } from './lib/neural-voice.mjs';
import { createTranscriber, WhisperServer } from './lib/stt.mjs';
import { ThreadBridge } from './lib/thread-bridge.mjs';
import { effectiveSettings, FOLLOW_CHOICES, readSettings, SPEED, updateSettings, VOICE_CHOICES } from './lib/settings.mjs';
import { createWakeGate, nameFromTitle } from './lib/wake.mjs';
import { createWakeWatch } from './lib/wake-state.mjs';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
// The window is the bar (364 x 56) plus a clear margin wide enough for its
// soft shadow and the orb's glow, so neither is cut off at the window edge.
const PAD_SIDE = 26;
const PAD_TOP = 26;
const PAD_BOTTOM = 34;
const WIDTH = 364 + 2 * PAD_SIDE;
const BASE_HEIGHT = 56 + PAD_TOP + PAD_BOTTOM;
const MAX_HEIGHT = 492;
// The bar sits this far above the bottom of the screen's work area.
const BAR_LIFT = 42;

// Previews and screenshot runs can use their own data folder, so they never
// meet the live bar (single-instance lock, log, saved settings).
if (process.env.EMBER_USER_DATA) app.setPath('userData', process.env.EMBER_USER_DATA);

// config.json, then this PC's config.local.json on top (lib/config.mjs).
const config = loadConfig(ROOT);
const startArgs = parseArgs(process.argv.slice(1));

// Shared by every bar: saved settings, the log, downloaded models.
const SHARED_DIR = app.getPath('userData');
// Thread mode runs one bar per thread, each a program of its own with its own
// data folder, and so its own single-instance lock: /ember in another thread
// opens a second bar instead of moving this one.
const BAR_ID = config.mode === 'thread' && !startArgs.mock && startArgs.session ? startArgs.session : null;
if (BAR_ID && !process.env.EMBER_USER_DATA) app.setPath('userData', path.join(SHARED_DIR, 'bars', BAR_ID));

// The settings panel's choices, saved per user and laid over config.json.
const settingsFile = path.join(SHARED_DIR, 'settings.json');
let current = effectiveSettings(config, readSettings(settingsFile));

// The other bars open now (one per thread), from their link files: each
// { sessionId, name }. Looked at most every few seconds.
const LINKS_DIR = path.join(SHARED_DIR, 'thread-links');
let otherBarsSeen = { at: 0, bars: [] };
// The spot this bar opened in (0 = centre), chosen in createWindow.
let barSlot = 0;
function otherBars() {
  if (!BAR_ID) return [];
  if (Date.now() - otherBarsSeen.at < 3000) return otherBarsSeen.bars;
  const bars = [];
  try {
    for (const file of readdirSync(LINKS_DIR)) {
      if (!file.endsWith('.json') || file === `${BAR_ID}.json`) continue;
      try {
        const link = JSON.parse(readFileSync(path.join(LINKS_DIR, file), 'utf8'));
        // A bar that crashed leaves its file behind: only living ones count.
        process.kill(link.pid, 0);
        bars.push({ sessionId: link.sessionId, name: String(link.name ?? ''), slot: Number.isInteger(link.slot) ? link.slot : null });
      } catch {
        // Unreadable, or its program is gone.
      }
    }
  } catch {
    // No links folder yet.
  }
  otherBarsSeen = { at: Date.now(), bars };
  return bars;
}

// The names this bar answers to. Alone, its wake word ("Ember") and its
// thread's name (when short, like "Juniper"). With other bars open, only its
// thread's name, and never a sentence that starts with another bar's name.
function threadName() {
  return threadMode && target?.sessionId ? nameFromTitle(target.title) : '';
}
function wakeNames() {
  const word = current.wakeWordOn ? current.wakeWord : '';
  const others = otherBars()
    .map((bar) => bar.name)
    .filter(Boolean);
  const own = threadName();
  if (!word) return { word: '', also: [], others };
  if (own && others.length) return { word: own, also: [], others };
  return { word, also: own ? [own] : [], others };
}
function buildWakeGate() {
  return createWakeGate({ followMs: current.wakeFollowMs, ...wakeNames() });
}
// No thread is attached yet at start; its name joins once one is.
let wakeGate = createWakeGate({ word: current.wakeWordOn ? current.wakeWord : '', followMs: current.wakeFollowMs });
// Words the speech model should expect: every name a bar answers to, said
// the way you say them, so "Juniper, ..." is heard as a name.
function speechHint() {
  const names = new Set();
  if (current.wakeWordOn && current.wakeWord) names.add(current.wakeWord);
  const own = threadName();
  if (own) names.add(own);
  for (const bar of otherBars()) if (bar.name) names.add(bar.name);
  const words = [...names].map((name) => name.replace(/\b\w/g, (c) => c.toUpperCase()));
  return words.length ? `${words.join(', ')}.` : '';
}

// Brings the names up to date before each sentence is judged.
function refreshWakeNames() {
  if (BAR_ID) wakeGate.rename(wakeNames());
}
// Tells the window when the bar wakes up or falls asleep.
const wakeWatch = createWakeWatch({ gate: () => wakeGate, onChange: (state) => send({ type: 'wake', ...state }) });
const threadMode = config.mode === 'thread' && !startArgs.mock;
// The preview has no speech engines at all, so it keeps the Windows voice.
const neuralWanted = isNeuralEngine(config.ttsEngine) && !(startArgs.mock && !startArgs.micTest);

let win = null;
// Where the bar belongs: its left edge and bottom edge. Resizing places the
// window from this, never from the window's own read-back position, which a
// scaled screen (175%, say) rounds by a pixel each time, so the bar would
// creep down a little on every resize. Only a drag changes it.
let anchor = null;
let bridge = null;
// What the bar was asked to speak lately, to tell your voice from its own.
const spokenLately = createSpokenMemory();
let transcriber = null;
let neuralVoice = null;
let neuralVoiceLoading = null;
let sdk = null;
let target = { sessionId: null, cwd: process.cwd(), title: 'New session' };
let rendererReady = false;
const backlog = [];

// In a plain preview nothing is real. In the mic test the microphone and the
// speech model are real and only Claude is a stand-in.
const fakeSpeech = startArgs.mock && !startArgs.micTest;
const debug = Boolean(process.env.EMBER_DEBUG);

// A short running log for troubleshooting, kept in the app's data folder
// (%APPDATA%\ember-voice\ember.log on Windows). What was said is only written
// when EMBER_DEBUG is set.
let logFile = null;
function log(line) {
  if (!line) return;
  try {
    if (!logFile) {
      const dir = process.env.EMBER_LOG_DIR || SHARED_DIR;
      mkdirSync(dir, { recursive: true });
      logFile = path.join(dir, 'ember.log');
      let size = 0;
      try {
        size = statSync(logFile).size;
      } catch {
        // First run: no log yet.
      }
      if (size > 512 * 1024) writeFileSync(logFile, '');
    }
    // Several bars share one log: each line names its bar's thread.
    const bar = BAR_ID ? `[${BAR_ID.slice(0, 6)}] ` : '';
    appendFileSync(logFile, `${new Date().toISOString()} ${bar}${line}\n`);
  } catch {
    // Logging must never break the widget.
  }
}

function describe(event) {
  switch (event.type) {
    case 'delta':
    case 'stt-progress':
    case 'wake':
      return null;
    case 'error':
      return `error: ${event.message}`;
    case 'offline':
      return `no thread is listening (session ${target.sessionId})`;
    case 'heard':
      return `heard ${event.text.length} characters${debug ? `: ${event.text}` : ''}`;
    case 'attached':
      return `attached: ${event.title}${event.isNew ? ' (new session)' : ''}`;
    case 'ready':
      return `ready: session ${event.sessionId}, model ${event.model}`;
    case 'tool':
      return `tool: ${event.name}`;
    case 'permission':
      return `asked permission: ${event.toolName}`;
    case 'done':
      return event.isError ? 'reply ended with an error' : `reply finished${threadMode ? `, ${event.text.length} characters` : ''}`;
    case 'title':
      return `thread renamed: ${event.title}`;
    case 'pc-awake':
      return `the PC ${event.why}; reopening the microphone`;
    default:
      return event.type;
  }
}

function send(event) {
  log(describe(event));
  if (win && rendererReady && !win.isDestroyed()) win.webContents.send('ember:event', event);
  else backlog.push(event);
}

if (!app.requestSingleInstanceLock() || startArgs.quit) {
  // A widget is already open; it picks up the session (or the request to
  // close) from our arguments.
  app.quit();
} else {
  app.on('second-instance', (_event, argv, workingDirectory) => {
    const args = parseArgs(argv.slice(1));
    if (args.quit) {
      log('asked to close');
      app.quit();
      return;
    }
    args.cwd ??= workingDirectory;
    // Also when it is already open: it may have slipped under other windows.
    bringToFront(win);
    if (args.session || args.fresh || args.latest) attach(args);
  });
  app.whenReady().then(boot);
  app.on('window-all-closed', () => app.quit());
  // The speech engine may be a separate program shared by every bar: leave
  // it, and the last bar to leave stops it.
  // In thread mode the link file must go too, so no thread keeps looking for us.
  app.on('will-quit', () => {
    transcriber?.stop();
    bridge?.dispose?.();
    neuralVoice?.dispose();
  });
  process.on('exit', () => {
    transcriber?.stop();
    bridge?.dispose?.();
  });
}

async function boot() {
  electronSession.defaultSession.setPermissionRequestHandler((_wc, permission, allow) => {
    allow(permission === 'media');
  });

  createWindow();
  wireIpc();
  // A microphone held across sleep or a locked screen can come back silent:
  // the window opens it afresh.
  powerMonitor.on('resume', () => send({ type: 'pc-awake', why: 'woke from sleep' }));
  powerMonitor.on('unlock-screen', () => send({ type: 'pc-awake', why: 'was unlocked' }));

  const kind = startArgs.micTest ? 'mic test' : startArgs.mock ? 'preview' : threadMode ? 'live, thread mode' : 'live';
  log(`started: ${kind}, Electron ${process.versions.electron}`);
  if (startArgs.mock) bridge = new MockBridge(config, { echo: startArgs.micTest });
  else if (threadMode) {
    let expectedVersion = null;
    try {
      expectedVersion = JSON.parse(readFileSync(path.join(ROOT, 'mod', 'ember-thread', '.claude-plugin', 'plugin.json'), 'utf8')).version;
    } catch {
      // Without it the bar simply does not compare versions.
    }
    bridge = new ThreadBridge(config, { expectedVersion });
  }
  else bridge = new ClaudeBridge(config);

  // Warm the speech engine now so the first sentence is not slow.
  if (!fakeSpeech) warmSpeech();
  // The natural voice loads alongside; until it is ready (or if it cannot
  // load) the window uses the Windows voice. It logs either way.
  if (!fakeSpeech && neuralWanted) {
    neuralVoiceLoading = loadNeuralVoice({ ...config, ttsVoice: current.ttsVoice, ttsSpeed: current.ttsSpeed }, {
      root: ROOT,
      defaultDir: path.join(SHARED_DIR, 'voice-models'),
      onLog: log,
    }).then(({ voice }) => (neuralVoice = voice));
  }

  // Used only by automated checks, so a run ends by itself and cleans up.
  const quitAfter = Number(process.env.EMBER_QUIT_AFTER_MS);
  if (quitAfter > 0) setTimeout(() => app.quit(), quitAfter);

  for (const name of ['ready', 'signed-out', 'thinking', 'delta', 'tool', 'permission', 'permission-cleared', 'done', 'error', 'closed', 'turn-started', 'offline', 'notice', 'progress', 'delivered']) {
    bridge.on(name, (payload) => send({ type: name, ...payload }));
  }
  // A finished reply keeps the no-name window open even with the voice muted.
  bridge.on('done', ({ text }) => {
    spokenLately.remember(text);
    wakeGate.touch();
    wakeWatch.update();
  });
  bridge.on('progress', ({ text }) => spokenLately.remember(text));
  bridge.on('session', ({ sessionId }) => {
    // From its first turn on, the session (new, or a copy) is the widget's own.
    target.sessionId = sessionId;
    target.owned = true;
    target.fork = false;
    log(`session id: ${sessionId}`);
  });
  bridge.on('log', (data) => {
    if (debug) log(`claude: ${String(data).trim()}`);
  });
  bridge.on('ready', ({ sessionId }) => {
    if (sessionId) target.sessionId = sessionId;
  });

  await attach(startArgs);
}

async function warmSpeech() {
  const options = {
    root: ROOT,
    dataDir: SHARED_DIR,
    // Every bar shares one speech server, written down in SHARED_DIR. The
    // bar's own folder may still hold the old one-server-per-bar record.
    pidDir: app.getPath('userData'),
    onProgress: (percent) => send({ type: 'stt-progress', percent }),
    onLog: log,
  };
  const began = Date.now();
  transcriber = createTranscriber(config, options);
  try {
    await transcriber.load();
  } catch (error) {
    log(`speech engine ${transcriber.name} failed: ${error.message}`);
    if (!(transcriber instanceof WhisperServer)) {
      send({ type: 'error', message: `The speech model could not load: ${error.message}` });
      return;
    }
    // The fast engine would not start (for example the graphics card is
    // full), so carry on with the slower built-in one.
    transcriber = createTranscriber({ ...config, sttEngine: 'built-in' }, options);
    try {
      await transcriber.load();
    } catch (second) {
      send({ type: 'error', message: `The speech model could not load: ${second.message}` });
      return;
    }
  }
  log(`speech engine ready: ${transcriber.name}, ${Date.now() - began} ms`);
  send({ type: 'stt-ready' });
}

async function attach(args) {
  try {
    if (startArgs.mock) {
      const title = startArgs.micTest ? 'Mic test (no usage spent)' : 'Preview (no usage spent)';
      target = { sessionId: 'preview', cwd: process.cwd(), title };
    } else {
      sdk ??= await import('@anthropic-ai/claude-agent-sdk');
      target = await resolveTarget(args, sdk, process.cwd());
      // An existing session is joined as a copy, so the original thread, which
      // may still be open elsewhere, is never written to by two programs at
      // once. A session the widget already owns is carried on in place.
      // In thread mode nothing is copied: the thread itself gets the words.
      target.fork = Boolean(!threadMode && config.forkSession && target.sessionId && !args.own);
      target.owned = Boolean(args.own);
      if (target.fork) target.title = `Copy of ${target.title}`;
      if (threadMode && !target.sessionId) target.title = 'No thread chosen';
    }
    send({ type: 'attached', title: target.title, isNew: !target.sessionId, mock: startArgs.mock });
    refreshWakeNames();
    watchTitle();
    const began = Date.now();
    await bridge.start({ sessionId: target.sessionId, cwd: target.cwd, fork: target.fork, wakeName: threadName(), slot: barSlot });
    if (threadMode) log(`waiting for thread ${target.sessionId} to answer on 127.0.0.1:${bridge.port}`);
    else log(`session process started in ${Date.now() - began} ms (folder: ${target.cwd})`);
  } catch (error) {
    send({ type: 'error', message: `Could not open the session: ${error.message}` });
  }
}

// The bar shows the thread's name and follows it when the thread is renamed
// in the app. There is no timer: Windows wakes the bar whenever the thread's
// saved history file changes (a rename is written there at once). That file
// also changes with every message, so the bar waits for it to go quiet, then
// reads the name once and passes it on only if it changed.
let titleWatcher = null;
let titleSettle = null;
const TITLE_SETTLE_MS = 1500;
function watchTitle() {
  titleWatcher?.close();
  titleWatcher = null;
  clearTimeout(titleSettle);
  if (startArgs.mock || !sdk || !target?.sessionId) return;
  const watching = target;
  const projectsDir = path.join(process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'), 'projects');
  const file = findSessionFile(watching.sessionId, projectsDir, { fs: { readdirSync, existsSync } });
  if (!file) {
    log('thread name: history file not found, the name will not follow renames');
    return;
  }
  const readTitle = async () => {
    if (target !== watching) return;
    try {
      const info = await sdk.getSessionInfo(watching.sessionId, { dir: watching.cwd });
      const title = info && sessionTitle(info);
      if (target === watching && title && title !== watching.title) {
        watching.title = title;
        refreshWakeNames();
        bridge.rename?.(threadName());
        send({ type: 'title', title });
      }
    } catch {
      // Unreadable mid-write; the next change tries again.
    }
  };
  try {
    titleWatcher = watch(file, () => {
      clearTimeout(titleSettle);
      titleSettle = setTimeout(readTitle, TITLE_SETTLE_MS);
    });
    titleWatcher.on('error', () => titleWatcher?.close());
  } catch (error) {
    log(`thread name: could not watch for renames (${error.message})`);
  }
}

// Where you last left this thread's bar, kept in the bar's own folder:
// { x, bottom } (the bottom edge, which stays put while the words panel grows
// upward). Null when it has never been moved, or that spot is off every screen.
const placeFile = () => path.join(app.getPath('userData'), 'place.json');
function savedPlace() {
  if (!BAR_ID) return null;
  try {
    const { x, bottom } = JSON.parse(readFileSync(placeFile(), 'utf8'));
    if (!Number.isFinite(x) || !Number.isFinite(bottom)) return null;
    const y = bottom - BASE_HEIGHT;
    const onScreen = screen.getAllDisplays().some(({ workArea: a }) => x + WIDTH / 2 >= a.x && x + WIDTH / 2 <= a.x + a.width && y >= a.y - PAD_TOP && bottom <= a.y + a.height + PAD_BOTTOM);
    return onScreen ? { x: Math.round(x), y: Math.round(y) } : null;
  } catch {
    return null;
  }
}
function rememberPlace() {
  if (!BAR_ID || !anchor) return;
  try {
    writeFileSync(placeFile(), JSON.stringify(anchor));
  } catch {
    // Not remembered this time; it opens in a free spot instead.
  }
}

function createWindow() {
  const area = screen.getPrimaryDisplay().workArea;
  // A new bar opens in the first free spot of a stack rising from the bottom
  // centre, one bar above the other with a small gap, never on top of an open
  // bar. Once you have moved it, it opens where you left it.
  //
  // The step is the least that keeps each window's clear shadow margin off
  // the bar next to it (a window's margin still takes clicks), which leaves a
  // gap of STACK_STEP - 56 px between the bars themselves.
  const STACK_STEP = BASE_HEIGHT - PAD_TOP;
  const taken = new Set(otherBars().map((bar) => bar.slot));
  barSlot = 0;
  while (taken.has(barSlot)) barSlot += 1;
  const bottomY = area.y + area.height - BAR_LIFT - (BASE_HEIGHT - PAD_BOTTOM);
  const free = {
    x: Math.round(area.x + (area.width - WIDTH) / 2),
    y: Math.max(area.y, bottomY - barSlot * STACK_STEP),
  };
  const place = savedPlace() ?? free;
  anchor = { x: place.x, bottom: place.y + BASE_HEIGHT };
  win = new BrowserWindow({
    width: WIDTH,
    height: BASE_HEIGHT,
    x: place.x,
    y: place.y,
    frame: false,
    transparent: true,
    resizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    hasShadow: false,
    show: false,
    backgroundColor: '#00000000',
    webPreferences: {
      preload: path.join(ROOT, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      backgroundThrottling: false,
    },
  });
  win.setAlwaysOnTop(true, 'floating');
  win.loadFile(path.join(ROOT, 'renderer', 'index.html'));
  win.once('ready-to-show', () => win.showInactive());
  // Dragged somewhere: that is where this thread's bar belongs and opens from
  // now on. ('moved' comes from a drag only, not from the resizes below.)
  win.on('moved', () => {
    const b = win.getBounds();
    anchor = { x: b.x, bottom: b.y + b.height };
    rememberPlace();
  });
  win.on('closed', () => {
    win = null;
  });
}

function wireIpc() {
  ipcMain.handle('ember:hello', () => {
    rendererReady = true;
    setImmediate(() => {
      while (backlog.length) win?.webContents.send('ember:event', backlog.shift());
    });
    return {
      mock: startArgs.mock,
      demo: Boolean(process.env.EMBER_SHOT_DIR),
      // Which screenshot run: '' the original four, 'looks' the wake and theme states.
      demoSet: process.env.EMBER_SHOT_SET || '',
      silenceMs: config.silenceMs,
      // Thread mode hands words into a running turn, so the mic stays open
      // while Claude works (never while it speaks).
      midTurn: threadMode,
      voiceName: config.voiceName,
      voiceRate: config.voiceRate,
      neuralVoice: neuralWanted,
      wake: wakeWatch.update(),
      settings: current,
    };
  });

  // The settings panel.
  ipcMain.handle('ember:settings', () => ({
    settings: current,
    voices: VOICE_CHOICES,
    follow: FOLLOW_CHOICES,
    speed: SPEED,
    neural: Boolean(neuralVoice),
  }));
  ipcMain.handle('ember:set-settings', (_event, patch) => {
    const before = current;
    current = updateSettings(settingsFile, config, patch);
    log(`settings changed: ${Object.keys(patch ?? {}).join(', ')}`);
    if (before.wakeWordOn !== current.wakeWordOn || before.wakeFollowMs !== current.wakeFollowMs) {
      wakeGate = buildWakeGate();
      wakeWatch.update();
    }
    return current;
  });

  // The window grows upward so the bar itself stays put. While it shows more
  // than the bar (what you said, a reply, a card), it comes to the front: with
  // bars stacked, those words go over the bar above instead of behind it. Bars
  // all float at one level, and Windows keeps the newer one in front, so
  // growing alone would leave them hidden. moveTop neither moves the window
  // nor takes the keyboard.
  ipcMain.on('ember:resize', (_event, wanted) => {
    if (!win) return;
    const height = Math.max(BASE_HEIGHT, Math.min(MAX_HEIGHT, Math.round(Number(wanted) || BASE_HEIGHT)));
    if (win.getBounds().height === height) return;
    win.setBounds({ x: anchor.x, y: anchor.bottom - height, width: WIDTH, height });
    if (height > BASE_HEIGHT) win.moveTop();
  });

  ipcMain.on('ember:log', (_event, line) => {
    // A reply that has just been spoken keeps the no-name window open.
    if (String(line).startsWith('spoke ')) {
      wakeGate.touch();
      wakeWatch.update();
    }
    log(`window: ${String(line).slice(0, 400)}`);
  });

  // The sentence so far, while you are still talking: if it is meant for the
  // bar (its name, or inside the no-name window), the bar glows at once and
  // shows the words as they come. One look at a time; a look still running
  // when the next is due is simply skipped.
  let partialBusy = false;
  ipcMain.handle('ember:partial', async (_event, buffer, overSpeech = false) => {
    if (partialBusy || fakeSpeech || !transcriber) return;
    partialBusy = true;
    try {
      const samples = new Float32Array(buffer);
      const text = await transcriber.transcribe(samples, { hint: speechHint() });
      if (!text) return;
      if (overSpeech && spokenLately.isEcho(text)) return;
      refreshWakeNames();
      const seen = wakeGate.peek(text, Date.now() - Math.round((samples.length / 16000) * 1000));
      if (seen.other) {
        // You named another bar: this one stops glowing and listening now.
        wakeWatch.update();
        send({ type: 'for-another' });
        return;
      }
      if (!seen.awake) return;
      if (seen.called) {
        // Your name for it, mid-sentence: awake from this moment.
        wakeGate.touch();
        wakeWatch.update();
      }
      send({ type: 'partial', text: seen.text, called: seen.called });
    } catch {
      // A missed look changes nothing; the whole sentence is read at the end.
    } finally {
      partialBusy = false;
    }
  });

  // `overSpeech`: you began while the bar was talking, so it may be the bar's
  // own voice coming back.
  ipcMain.handle('ember:utterance', async (_event, buffer, overSpeech = false) => {
    if (fakeSpeech) {
      const text = 'Tell me what this widget does.';
      send({ type: 'heard', text });
      bridge.send(text);
      return;
    }
    try {
      const samples = new Float32Array(buffer);
      const began = Date.now();
      const text = await transcriber.transcribe(samples, { hint: speechHint() });
      log(`transcribed ${(samples.length / 16000).toFixed(1)} s of audio in ${Date.now() - began} ms`);
      if (!text) {
        send({ type: 'heard-nothing' });
        return;
      }
      if (overSpeech && spokenLately.isEcho(text)) {
        log(`ignored ${text.length} characters heard over the voice: its own words`);
        send({ type: 'heard-nothing' });
        return;
      }
      // Judged by when you STARTED speaking: a long sentence begun inside the
      // no-name window still counts, however long it took to say.
      refreshWakeNames();
      const wanted = wakeGate.check(text, began - Math.round((samples.length / 16000) * 1000));
      if (wanted.ignored !== true) wakeGate.touch();
      wakeWatch.update();
      if (wanted.text === undefined) {
        log(wanted.other ? `ignored ${text.length} characters, meant for another bar` : wanted.called ? 'heard its name, listening' : `ignored ${text.length} characters, no wake word${debug ? `: ${text}` : ''}`);
        send({ type: wanted.other ? 'for-another' : 'heard-nothing' });
        return;
      }
      send({ type: 'heard', text: wanted.text });
      bridge.send(wanted.text);
    } catch (error) {
      send({ type: 'error', message: `Could not make out the audio: ${error.message}` });
    }
  });

  ipcMain.handle('ember:say', (_event, text) => {
    const clean = String(text ?? '').trim();
    if (!clean) return;
    send({ type: 'heard', text: clean });
    bridge.send(clean);
  });

  // The natural voice: the window asks for each piece of a reply and plays it.
  ipcMain.handle('ember:tts', async (_event, text) => {
    await neuralVoiceLoading;
    if (!neuralVoice) throw new Error('neural voice unavailable');
    // Voice and speed are read on every sentence, so a change in the settings
    // panel applies from the next one.
    return neuralVoice.synthesize(String(text ?? ''), { voice: current.ttsVoice, speed: current.ttsSpeed });
  });
  ipcMain.on('ember:tts-stop', () => neuralVoice?.stop());

  ipcMain.handle('ember:interrupt', () => bridge.interrupt());
  ipcMain.handle('ember:reconnect', () => reconnect());
  ipcMain.handle('ember:permission', (_event, id, allow) => bridge.answerPermission(id, allow === true));
  ipcMain.handle('ember:open-session', () => {
    // Opening a thread a second time would split its history.
    if (threadMode) send({ type: 'notice', message: 'This thread is open in the Claude app' });
    else openInTerminal();
  });
  ipcMain.on('ember:menu', () => showMenu());

  ipcMain.on('ember:shot', async (_event, file, rect) => {
    // Used only by the automated screenshot check. `rect` crops to a part.
    if (!process.env.EMBER_SHOT_DIR || !win) return;
    const image = await win.webContents.capturePage(rect || undefined);
    const { writeFileSync } = await import('node:fs');
    writeFileSync(path.join(process.env.EMBER_SHOT_DIR, path.basename(file)), image.toPNG());
  });
  ipcMain.on('ember:quit', () => app.quit());
}

// Open the same session again, for example after signing in.
function reconnect() {
  return attach({ session: target.sessionId, cwd: target.cwd, fresh: !target.sessionId, own: target.owned });
}

async function showMenu() {
  const recents = startArgs.mock || !sdk ? [] : await recentSessions(sdk);
  const menu = Menu.buildFromTemplate([
    { label: target.title, enabled: false },
    { type: 'separator' },
    { label: 'Type a message', click: () => send({ type: 'type-request' }) },
    {
      label: 'Switch session',
      enabled: recents.length > 0,
      submenu: recents.map((item) => ({
        label: item.title,
        type: 'radio',
        checked: item.sessionId === target.sessionId,
        click: () => attach({ session: item.sessionId, cwd: item.cwd, fresh: false }),
      })),
    },
    { label: 'Start a new session', visible: !threadMode, click: () => attach({ session: null, cwd: target.cwd, fresh: true }) },
    { label: 'Open this session in a terminal', visible: !threadMode, enabled: Boolean(target.sessionId) && !startArgs.mock, click: openInTerminal },
    { label: 'Reconnect', enabled: !startArgs.mock, click: reconnect },
    { type: 'separator', visible: !threadMode },
    ...config.models.map((model) => ({
      visible: !threadMode,
      label: model.label,
      type: 'radio',
      checked: bridge.model === model.id,
      click: async () => {
        try {
          await bridge.setModel(model.id);
          send({ type: 'notice', message: `Now using ${model.label}` });
        } catch (error) {
          send({ type: 'error', message: `Could not switch model: ${error.message}` });
        }
      },
    })),
    { type: 'separator' },
    { label: 'Quit', click: () => app.quit() },
  ]);
  menu.popup({ window: win });
}

function openInTerminal() {
  if (!target.sessionId || startArgs.mock) return;
  const id = target.sessionId;
  const options = { cwd: target.cwd, detached: true, stdio: 'ignore' };
  let child;
  if (process.platform === 'win32') {
    child = spawn('cmd.exe', ['/c', 'start', '""', 'cmd', '/k', `claude --resume ${id}`], options);
  } else if (process.platform === 'darwin') {
    const script = `tell application "Terminal" to do script "cd ${JSON.stringify(target.cwd)} && claude --resume ${id}"`;
    child = spawn('osascript', ['-e', script], options);
  } else {
    child = spawn('x-terminal-emulator', ['-e', `claude --resume ${id}`], options);
  }
  child.on('error', (error) => send({ type: 'error', message: `Could not open a terminal: ${error.message}` }));
  child.unref();
}
