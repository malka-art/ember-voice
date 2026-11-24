// Local speech-to-text. Nothing spoken leaves this computer.
//
// Two engines, picked by createTranscriber():
//   WhisperServer  whisper.cpp's server running on the graphics card, one
//                  shared by every bar. Fast (about 0.35 s a short sentence,
//                  0.5 s a 16 s one, with large-v3-turbo on an RTX 2060 SUPER,
//                  in 1.7 GB of graphics memory). Needs the whisper.cpp build
//                  and a model file on this computer ("npm run setup").
//   Transcriber    Whisper running inside the app through transformers.js. No
//                  extra files needed, the model downloads on first use, but
//                  it takes a few seconds a sentence.

import { execFile, execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import path from 'node:path';
import { promisify } from 'node:util';

import { expandEnv } from './config.mjs';

const execFileAsync = promisify(execFile);

export class Transcriber {
  constructor({ model, dtype, device, cacheDir, onProgress }) {
    this.name = `built-in ${model}`;
    this.model = model;
    this.dtype = dtype;
    this.device = device;
    this.cacheDir = cacheDir;
    this.onProgress = onProgress;
    this.loading = null;
  }

  load() {
    this.loading ??= this.#load().catch((error) => {
      this.loading = null;
      throw error;
    });
    return this.loading;
  }

  async #load() {
    const { pipeline, env } = await import('@huggingface/transformers');
    env.cacheDir = this.cacheDir;
    const options = {
      progress_callback: (p) => {
        if (p.status === 'progress' && p.total) this.onProgress?.(Math.round((p.loaded / p.total) * 100));
      },
    };
    if (this.dtype) options.dtype = this.dtype;
    if (this.device) options.device = this.device;
    return pipeline('automatic-speech-recognition', this.model, options);
  }

  async transcribe(samples) {
    const asr = await this.load();
    const result = await asr(samples, { chunk_length_s: 30, stride_length_s: 5 });
    return cleanTranscript(Array.isArray(result) ? result.map((r) => r.text).join(' ') : result.text);
  }

  stop() {}
}

// whisper.cpp's server, ONE for every bar: the graphics card has room for one
// copy of a large model, not one per bar. The first bar starts it and writes
// down where it is (speech-server.json in the shared data folder, with every
// bar using it); later bars join it. It runs on its own, not as a bar's child,
// so it outlives the bar that started it, and it stops when the last bar using
// it closes. If bars crash instead of closing, it keeps running and the next
// bar to open joins it again.
export class WhisperServer {
  constructor({ exe, model, threads = 8, stateFile, legacyPidFile, onLog }) {
    this.name = `whisper.cpp ${path.basename(model)}`;
    this.exe = exe;
    this.model = model;
    this.threads = threads;
    this.stateFile = stateFile;
    this.lockFile = `${stateFile}.lock`;
    this.legacyPidFile = legacyPidFile;
    this.onLog = onLog;
    this.me = { pid: process.pid, program: path.basename(process.execPath) };
    this.port = null;
    this.loading = null;
    this.joined = false;
    // Set once this bar has found a server: if it goes away later, the bar
    // takes whichever server is running then, whatever its model, so two bars
    // with different settings never keep replacing each other's.
    this.anyModel = false;
  }

  load() {
    this.loading ??= this.#join().catch((error) => {
      this.loading = null;
      throw error;
    });
    return this.loading;
  }

  async #join() {
    await withLock(this.lockFile, async () => {
      this.#clearLegacy();
      const state = readState(this.stateFile);
      const users = keepUsers(state?.users, { leaving: this.me.pid, running: (u) => alive(u.pid) });
      if (state && (await runsSoon(state.pid, path.basename(state.exe ?? this.exe)))) {
        const answering = await answers(state.port);
        if (answering && (this.anyModel || samePath(state.model, this.model))) {
          writeState(this.stateFile, { ...state, users: [...users, this.me] });
          this.#use(state);
          this.onLog?.(`joined the shared speech server (process ${state.pid}, ${users.length} other bar${users.length === 1 ? '' : 's'})`);
          return;
        }
        // Newer settings win: the other bars move to the new one by themselves.
        stopProgram(state.pid);
        this.onLog?.(`stopped the shared speech server (process ${state.pid}): ${answering ? `it had ${path.basename(state.model)}` : 'it did not answer'}`);
      }
      await this.#start(users);
    });
  }

  async #start(users) {
    const port = await freePort();
    const args = ['-m', this.model, '--host', '127.0.0.1', '--port', String(port), '-t', String(this.threads), '-l', 'en', '-mc', '0', '-nlp'];
    // Detached: not tied to this bar, so closing this bar leaves it running
    // for the others.
    const child = spawn(this.exe, args, { cwd: path.dirname(this.exe), windowsHide: true, stdio: 'ignore', detached: true });
    let failure = null;
    child.once('error', (error) => (failure = error));
    child.once('exit', (code) => (failure ??= new Error(`the speech server stopped (code ${code})`)));
    child.unref();
    if (!child.pid) {
      await new Promise((resolve) => setImmediate(resolve));
      throw failure ?? new Error('the speech server would not start');
    }
    const state = { pid: child.pid, port, exe: this.exe, model: this.model, startedAt: new Date().toISOString(), users: [...users, this.me] };
    writeState(this.stateFile, state);
    this.joined = true;

    // A large model can take half a minute to load from disk.
    const deadline = Date.now() + 120000;
    for (;;) {
      if (!failure && Date.now() > deadline) failure = new Error('the speech server did not start in time');
      if (failure) {
        stopProgram(child.pid);
        writeState(this.stateFile, null);
        this.joined = false;
        throw failure;
      }
      if (await answers(port)) break;
      await sleep(250);
    }
    this.#use(state);
    this.onLog?.(`started the shared speech server (process ${child.pid}, port ${port})`);
  }

  #use(state) {
    this.port = state.port;
    this.joined = true;
    this.anyModel = true;
    this.name = `whisper.cpp ${path.basename(state.model)}, shared`;
  }

  // `hint`: words to expect (the bars' names), handed to the model as its
  // starting context so a name at the start of a sentence is heard as itself.
  async transcribe(samples, { hint = '' } = {}) {
    try {
      return await this.#ask(samples, hint);
    } catch (error) {
      // Busy, or a real error from the model: not a reason to look elsewhere.
      if (!(error instanceof TypeError)) throw error;
      // The server went away (another bar replaced it, or it crashed): find
      // or start the one running now, and try once more.
      this.onLog?.('the shared speech server went away; finding it again');
      this.loading = null;
      return this.#ask(samples, hint);
    }
  }

  async #ask(samples, hint) {
    await this.load();
    const form = new FormData();
    form.append('file', new Blob([encodeWav(samples)], { type: 'audio/wav' }), 'utterance.wav');
    form.append('response_format', 'json');
    form.append('temperature', '0.0');
    if (hint) form.append('prompt', hint);
    const response = await fetch(`http://127.0.0.1:${this.port}/inference`, {
      method: 'POST',
      body: form,
      signal: AbortSignal.timeout(60000),
    });
    if (!response.ok) throw new Error(`the speech server answered ${response.status}`);
    const result = await response.json();
    if (result.error) throw new Error(String(result.error));
    return cleanTranscript(result.text);
  }

  // Leaves the shared server; the last bar to leave stops it. Runs as the bar
  // quits, so it must finish there and then.
  stop() {
    if (!this.joined) return;
    this.joined = false;
    this.loading = null;
    const done = withLockSync(this.lockFile, () => {
      const state = readState(this.stateFile);
      if (!state) return;
      const users = keepUsers(state.users, { leaving: this.me.pid, running: (u) => alive(u.pid) });
      if (users.length) {
        writeState(this.stateFile, { ...state, users });
        return;
      }
      if (runs(state.pid, path.basename(state.exe ?? this.exe))) {
        stopProgram(state.pid);
        this.onLog?.(`stopped the shared speech server (process ${state.pid}): no bar uses it now`);
      }
      writeState(this.stateFile, null);
    });
    // Another bar is starting the server right now; it uses it, so this bar
    // was not the last. Its record here is dropped when the next bar looks.
    if (!done) this.onLog?.('left the shared speech server without updating its record (it was busy)');
  }

  // Before bars shared one server each bar ran its own and kept its process
  // id in its own folder. If one was left running (a crash), stop it, but only
  // if that process id still belongs to a whisper server.
  #clearLegacy() {
    if (!this.legacyPidFile || !existsSync(this.legacyPidFile)) return;
    try {
      const pid = Number(readFileSync(this.legacyPidFile, 'utf8').trim());
      const shared = readState(this.stateFile);
      if (pid !== shared?.pid && runs(pid, path.basename(this.exe))) {
        stopProgram(pid);
        this.onLog?.(`stopped a speech server left over from last time (process ${pid})`);
      }
    } catch {
      // Nothing to tidy.
    }
    rmSync(this.legacyPidFile, { force: true });
  }
}

// The bars still using the shared server: without the one leaving, and
// without any whose program has gone (a bar that crashed never says goodbye).
export function keepUsers(users, { leaving, running }) {
  const kept = [];
  for (const user of Array.isArray(users) ? users : []) {
    if (!Number.isInteger(user?.pid) || user.pid === leaving || kept.some((k) => k.pid === user.pid)) continue;
    if (running(user)) kept.push({ pid: user.pid, program: String(user.program ?? '') });
  }
  return kept;
}

function readState(file) {
  try {
    const state = JSON.parse(readFileSync(file, 'utf8'));
    return Number.isInteger(state?.pid) && Number.isInteger(state?.port) ? state : null;
  } catch {
    return null;
  }
}

// Written whole to a side file and moved into place, so a reader never sees
// half of it. `null` removes it.
function writeState(file, state) {
  if (!state) {
    rmSync(file, { force: true });
    return;
  }
  mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.tmp`;
  writeFileSync(temp, JSON.stringify(state, null, 2));
  renameSync(temp, file);
}

// Whether process `pid` is still running (instant).
function alive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

// Whether process `pid` is still running `program` (by its file name), so a
// process id that Windows has since given to something else is never taken
// for it. About a third of a second, so only for the speech server itself.
const taskQuery = (pid) => ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'];
const programIn = (out, pid) => {
  const match = /^"([^"]*)","(\d+)"/m.exec(out);
  return match && Number(match[2]) === pid ? match[1].toLowerCase() : null;
};
function runs(pid, program) {
  if (!alive(pid)) return false;
  if (process.platform !== 'win32') return true;
  try {
    return programIn(execFileSync('tasklist', taskQuery(pid), { encoding: 'utf8', windowsHide: true }), pid) === program.toLowerCase();
  } catch {
    return false;
  }
}
async function runsSoon(pid, program) {
  if (!alive(pid)) return false;
  if (process.platform !== 'win32') return true;
  try {
    const { stdout } = await execFileAsync('tasklist', taskQuery(pid), { encoding: 'utf8', windowsHide: true });
    return programIn(stdout, pid) === program.toLowerCase();
  } catch {
    return false;
  }
}

// Stops a program and waits (a few seconds at most) until it has gone, so its
// graphics memory is free before anything new loads.
function stopProgram(pid) {
  try {
    process.kill(pid);
  } catch {
    return;
  }
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0);
    } catch {
      return;
    }
    pause(50);
  }
}

const samePath = (a, b) => path.resolve(String(a ?? '')).toLowerCase() === path.resolve(String(b ?? '')).toLowerCase();

async function answers(port) {
  try {
    await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(1000) });
    return true;
  } catch {
    return false;
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// A short wait that blocks, for the moment a bar quits.
function pause(ms) {
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  } catch {
    const until = Date.now() + ms;
    while (Date.now() < until);
  }
}

// One bar at a time reads and changes speech-server.json: a lock file made
// with "create only if missing", holding the owner's process id. A lock whose
// owner has gone, or that is older than any start could take, is stale.
const LOCK_STALE_MS = 180000;
function tryLock(lockFile) {
  try {
    mkdirSync(path.dirname(lockFile), { recursive: true });
    writeFileSync(lockFile, String(process.pid), { flag: 'wx' });
    return true;
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
  }
  try {
    const age = Date.now() - statSync(lockFile).mtimeMs;
    const owner = Number(readFileSync(lockFile, 'utf8').trim());
    // An empty lock was made a moment ago and its owner is still writing it.
    const ownerGone = owner > 0 ? !alive(owner) : age > 5000;
    if (ownerGone || age > LOCK_STALE_MS) rmSync(lockFile, { force: true });
  } catch {
    // It went away while we looked; try again next time round.
  }
  return false;
}

async function withLock(lockFile, work, { waitMs = 150000 } = {}) {
  const deadline = Date.now() + waitMs;
  while (!tryLock(lockFile)) {
    if (Date.now() > deadline) throw new Error('another bar is still starting the speech server');
    await sleep(100);
  }
  try {
    return await work();
  } finally {
    rmSync(lockFile, { force: true });
  }
}

// The same, blocking, for quitting. Returns false if the lock stayed taken.
function withLockSync(lockFile, work, { waitMs = 3000 } = {}) {
  const deadline = Date.now() + waitMs;
  while (!tryLock(lockFile)) {
    if (Date.now() > deadline) return false;
    pause(50);
  }
  try {
    work();
    return true;
  } finally {
    rmSync(lockFile, { force: true });
  }
}

// Best first. When the model in config.json is not on this computer the bar
// takes the best of these that is, so it always hears without any setup.
const SPEECH_MODELS = ['ggml-large-v3-turbo.bin', 'ggml-small.en.bin', 'ggml-base.en.bin'];

// The model file to use: the configured one if it is there, otherwise the
// best of SPEECH_MODELS found in `dirs` (the shared speech-models folder,
// then the whisper.cpp folder). `model` is null when there is none at all;
// `wanted` is the configured one, for the log.
export function pickWhisperModel(configured, { dirs, exists }) {
  const name = configured || SPEECH_MODELS[0];
  // A plain file name may be in any of the folders (setup puts models in the
  // first); `wanted` is where it is, or the first place it could be.
  const places = path.isAbsolute(name) ? [name] : dirs.map((dir) => path.join(dir, name));
  const wanted = places.find((place) => exists(place)) ?? places[0];
  if (exists(wanted)) return { model: wanted, wanted };
  for (const file of SPEECH_MODELS) {
    for (const dir of dirs) {
      const candidate = path.join(dir, file);
      if (exists(candidate)) return { model: candidate, wanted };
    }
  }
  return { model: null, wanted };
}

// Picks the fast engine when its files are on this computer, and otherwise
// the built-in one. `root` is the app folder; `dataDir` the folder every bar
// shares (where the one speech server is written down); `pidDir` a bar's own
// folder, looked at once to tidy up after the old one-server-per-bar way.
export function createTranscriber(config, { root, dataDir, pidDir = dataDir, onProgress, onLog }) {
  const builtIn = () =>
    new Transcriber({
      model: config.sttModel,
      dtype: config.sttDtype,
      device: config.sttDevice,
      cacheDir: path.join(dataDir, 'models'),
      onProgress,
    });

  const engine = config.sttEngine || 'auto';
  if (engine === 'built-in') return builtIn();

  // Empty: the folder "npm run setup" fills. A path may use %NAME%.
  const dir = config.whisperDir ? path.resolve(root, expandEnv(config.whisperDir)) : path.join(dataDir, 'whisper');
  const exe = path.join(dir, process.platform === 'win32' ? 'whisper-server.exe' : 'whisper-server');
  const { model, wanted } = pickWhisperModel(expandEnv(config.whisperModel), { dirs: [path.join(dataDir, 'speech-models'), dir], exists: existsSync });
  if (existsSync(exe) && model) {
    if (model !== wanted) onLog?.(`speech model ${wanted} is not on this computer; using ${model}`);
    return new WhisperServer({
      exe,
      model,
      threads: config.whisperThreads,
      stateFile: path.join(dataDir, 'speech-server.json'),
      legacyPidFile: path.join(pidDir, 'speech-server.pid'),
      onLog,
    });
  }
  onLog?.(
    existsSync(exe)
      ? `no whisper.cpp speech model is on this computer (looked for ${wanted} and ${SPEECH_MODELS.join(', ')}); using the built-in one. "npm run setup" adds one`
      : `the fast speech engine was not found at ${dir}; using the built-in one. "npm run setup" adds it`,
  );
  return builtIn();
}

// 16 kHz mono 16-bit WAV, the format whisper.cpp reads directly.
export function encodeWav(samples, sampleRate = 16000) {
  const out = Buffer.alloc(44 + samples.length * 2);
  out.write('RIFF', 0, 'ascii');
  out.writeUInt32LE(36 + samples.length * 2, 4);
  out.write('WAVE', 8, 'ascii');
  out.write('fmt ', 12, 'ascii');
  out.writeUInt32LE(16, 16);
  out.writeUInt16LE(1, 20);
  out.writeUInt16LE(1, 22);
  out.writeUInt32LE(sampleRate, 24);
  out.writeUInt32LE(sampleRate * 2, 28);
  out.writeUInt16LE(2, 32);
  out.writeUInt16LE(16, 34);
  out.write('data', 36, 'ascii');
  out.writeUInt32LE(samples.length * 2, 40);
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    out.writeInt16LE(Math.round(s < 0 ? s * 32768 : s * 32767), 44 + i * 2);
  }
  return out;
}

function freePort() {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

// Whisper invents short phrases for silence and noise; drop those.
const NOISE = /^(\[[^\]]*\]|\([^)]*\)|you|thank you\.?|thanks for watching[.!]?|\.+)$/i;

// Sound labels Whisper writes in the middle of real words too: "[BLANK_AUDIO]",
// "*Bird noises*", "(upbeat music)", "♪". Never something you said.
const SOUND_TAGS = [/\[[^\]]{0,40}\]/g, /\*[^*\n]{1,40}\*/g, /\((?:[a-z]+ ?){1,3}\)/g, /[♪♫]+/g];

export function cleanTranscript(text) {
  let trimmed = String(text ?? '');
  for (const tag of SOUND_TAGS) trimmed = trimmed.replace(tag, ' ');
  trimmed = collapseLoops(trimmed.replace(/\s+/g, ' ').trim());
  if (!trimmed || NOISE.test(trimmed) || !/[a-z0-9]/i.test(trimmed)) return '';
  return trimmed;
}

// On long or noisy audio Whisper can get stuck and write the same sentence
// or phrase over and over ("I would like to check out the project." again
// and again). A run of three or more copies back to back becomes one. Two
// copies stay: people do say "no, no" or repeat a sentence on purpose.
export function collapseLoops(text) {
  const words = String(text ?? '').split(' ').filter(Boolean);
  const key = (word) => word.toLowerCase().replace(/[^a-z0-9']/g, '');
  const out = [];
  let i = 0;
  while (i < words.length) {
    // The phrase whose copies cover the most words wins; on a tie the
    // shortest, so six copies of a sentence become one, not two.
    let best = null;
    for (let size = 1; size <= Math.min(30, Math.floor((words.length - i) / 3)); size++) {
      const same = (a, b) => {
        for (let k = 0; k < size; k++) if (key(words[a + k]) !== key(words[b + k])) return false;
        return true;
      };
      let copies = 1;
      while (i + (copies + 1) * size <= words.length && same(i, i + copies * size)) copies++;
      // A single word needs more copies before it counts ("very, very, very").
      if (copies < (size === 1 ? 4 : 3)) continue;
      if (!best || copies * size > best.copies * best.size) best = { size, copies };
    }
    if (best) {
      out.push(...words.slice(i, i + best.size));
      i += best.copies * best.size;
    } else {
      out.push(words[i++]);
    }
  }
  return out.join(' ');
}
