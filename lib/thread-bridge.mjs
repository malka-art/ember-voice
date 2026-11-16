// Thread mode: the bar is only a microphone and a speaker for a thread that
// is already open in the Claude app. It runs no Claude session of its own.
//
// The other half is the "ember-thread" mod (code/mod/ember-thread), which
// runs inside every Claude Code session. This file:
//   1. serves a tiny endpoint on 127.0.0.1 (random port, secret token),
//   2. writes a link file naming the ONE session it wants to talk to,
//   3. hands that session's mod what was heard, and receives its replies.
// Only the named session's mod ever calls the endpoint; every other session
// reads the link file, sees another id, and stays quiet.
//
// Events are the same ones ClaudeBridge gives, plus:
//   turn-started {}          a turn began in the thread (spoken or typed)
//   progress     { text }    text Claude wrote mid-turn, to speak at once
//   delivered    { id }      words the bar sent are now in the thread
//   offline      { message, status, spoken } no live thread is listening
//   notice       { message }

import { EventEmitter } from 'node:events';
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import path from 'node:path';

const STOPPED = 'the session was stopped and nobody has sent input since';
const REMOVED = 'was removed from the queue before it ran';

export const NOT_LISTENING =
  'That thread is not listening. Open it in the Claude app and send it any message, then speak again.';
export const STOPPED_HELP =
  'Claude was stopped in the thread, so it is not taking voice. Type anything in the thread and I will send what you said.';
export const NO_THREAD = 'Thread mode needs a thread. Type /ember in the thread you want to talk in.';

// Where a bar tells its thread's mod that it is listening: one file per
// thread, so several bars (one per thread) can be open at once. The mod reads
// the same path from the APPDATA variable, so the two must agree.
export function linkDirPath(env = process.env) {
  return env.APPDATA ? path.join(env.APPDATA, 'ember-voice', 'thread-links') : null;
}

export function linkFilePath(env = process.env, sessionId = null) {
  const dir = linkDirPath(env);
  return dir && sessionId ? path.join(dir, `${sessionId}.json`) : null;
}

export function isRetryable(reason) {
  return typeof reason === 'string' && (reason.includes(STOPPED) || reason.includes(REMOVED));
}

export class ThreadBridge extends EventEmitter {
  constructor(config = {}, options = {}) {
    super();
    this.config = config;
    // Tests pass one fixed file; otherwise each thread has its own.
    this.fixedLinkFile = options.linkFile ?? null;
    this.linkFile = this.fixedLinkFile;
    // Its name as a wake word, written into the link so other bars know it.
    this.wakeName = '';
    // Which spot along the bottom of the screen the bar opened in, written into
    // the link so the next bar to open takes a free one.
    this.slot = 0;
    this.pollHoldMs = options.pollHoldMs ?? 20000;
    // How long after attaching before saying nobody is listening.
    this.graceMs = options.graceMs ?? 8000;
    // A listening thread asks again within a second or two of each answer.
    // Longer than this with no question open means its process has ended.
    this.gapMs = options.gapMs ?? 8000;
    // The mod version this bar was written against (code/mod/ember-thread).
    this.expectedVersion = options.expectedVersion ?? null;
    // Speech that could not be sent is only worth sending for a short while.
    this.retryMaxAgeMs = options.retryMaxAgeMs ?? 120000;
    this.now = options.now ?? Date.now;

    this.model = 'the model chosen in the thread';
    this.sessionId = null;
    this.cwd = null;
    this.busy = false;
    this.listening = false;
    this.modVersion = null;

    this.server = null;
    this.port = null;
    this.token = null;
    this.queue = []; // heard, not yet handed to the mod
    this.sent = new Map(); // handed to the mod, not yet confirmed
    this.held = []; // refused by a stopped session, kept to send again
    this.waiter = null; // the mod's open poll
    this.attachedAt = 0;
    this.idleSince = 0; // when the mod last had no poll open
    this.saidOffline = false;
    this.skipReply = false;
    this.watchdog = null;
  }

  async start({ sessionId = null, cwd = process.cwd(), wakeName = '', slot = 0 } = {}) {
    this.#release({ unlink: true });
    // Letting go of the thread it had, if any, before taking the new one.
    this.#removeLink();
    this.linkFile = this.fixedLinkFile ?? linkFilePath(process.env, sessionId);
    this.wakeName = wakeName;
    this.slot = slot;
    this.queue = [];
    this.sent.clear();
    this.held = [];
    this.busy = false;
    this.listening = false;
    this.saidOffline = false;
    this.skipReply = false;
    this.sessionId = sessionId;
    this.cwd = cwd;

    if (!sessionId) {
      this.#removeLink();
      this.#noThread();
      return;
    }
    if (!this.linkFile) {
      this.emit('error', { message: 'Thread mode needs the APPDATA folder, which this computer does not report.' });
      return;
    }

    await this.#listen();
    this.attachedAt = this.now();
    this.#writeLink();
    this.watchdog ??= setInterval(() => this.check(), 1000);
    this.watchdog.unref?.();
  }

  // Called once a second: notices a thread that never answered or went quiet.
  check() {
    if (!this.sessionId) return;
    const now = this.now();
    if (this.listening && !this.waiter && now - this.idleSince > this.gapMs) {
      this.listening = false;
      this.busy = false;
      this.#offline();
    } else if (!this.listening && !this.saidOffline && now - this.attachedAt > this.graceMs) {
      this.#offline();
    }
  }

  #offline() {
    this.saidOffline = true;
    this.emit('offline', { message: NOT_LISTENING, status: 'Thread is not listening', spoken: 'That thread is not listening.' });
  }

  #noThread() {
    this.emit('offline', { message: NO_THREAD, status: 'No thread chosen', spoken: '' });
  }

  send(text) {
    if (!this.sessionId) {
      this.#noThread();
      return;
    }
    if (!this.listening) {
      // Never keep words for a thread that may wake up much later.
      this.#offline();
      return;
    }
    this.busy = true;
    this.queue.push({ id: randomUUID(), text, at: this.now() });
    this.#flush();
  }

  // The thread's own turn is left running: stopping it from outside would
  // make it refuse voice until something is typed in it. Only the reply to
  // the turn in progress is dropped, so the bar stays quiet.
  async interrupt() {
    if (this.busy) this.skipReply = true;
  }

  // The thread was renamed: other bars learn its new wake name.
  rename(wakeName) {
    this.wakeName = wakeName;
    if (this.sessionId && this.linkFile && this.server) this.#writeLink();
  }

  async setModel() {
    throw new Error('In thread mode the model is chosen in the thread itself.');
  }

  // Approvals for a thread are asked in the Claude app, not in the bar.
  answerPermission() {}

  async stop() {
    this.dispose();
    const server = this.server;
    this.server = null;
    this.port = null;
    if (server) {
      server.closeAllConnections?.();
      await new Promise((resolve) => server.close(resolve));
    }
  }

  // The part of stopping that must also work while the app is quitting.
  dispose() {
    clearInterval(this.watchdog);
    this.watchdog = null;
    this.#release({ unlink: true });
    this.#removeLink();
    this.sessionId = null;
    this.listening = false;
  }

  async #listen() {
    if (this.server) return;
    this.token = randomBytes(32).toString('hex');
    const server = http.createServer((request, response) => this.#handle(request, response));
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      // This computer only: never reachable from the network.
      server.listen(0, '127.0.0.1', resolve);
    });
    this.server = server;
    this.port = server.address().port;
  }

  #writeLink() {
    mkdirSync(path.dirname(this.linkFile), { recursive: true });
    const body = JSON.stringify({ sessionId: this.sessionId, port: this.port, token: this.token, pid: process.pid, name: this.wakeName, slot: this.slot });
    // Written whole, then swapped in, so the mod never reads half a file.
    const draft = `${this.linkFile}.${process.pid}.tmp`;
    writeFileSync(draft, body);
    renameSync(draft, this.linkFile);
  }

  #removeLink() {
    if (!this.linkFile || !this.token) return;
    try {
      // Only ever remove our own link, not one a newer bar wrote.
      if (JSON.parse(readFileSync(this.linkFile, 'utf8')).token === this.token) rmSync(this.linkFile, { force: true });
    } catch {
      // Already gone.
    }
  }

  #authorised(request) {
    const given = Buffer.from(String(request.headers['x-ember-token'] ?? ''));
    const wanted = Buffer.from(this.token);
    return given.length === wanted.length && timingSafeEqual(given, wanted);
  }

  #handle(request, response) {
    const reply = (status, body) => {
      if (response.writableEnded) return;
      response.writeHead(status, { 'content-type': 'application/json' });
      response.end(JSON.stringify(body));
    };
    if (request.method !== 'POST' || !this.#authorised(request)) {
      request.resume();
      reply(403, { error: 'not allowed' });
      return;
    }
    const chunks = [];
    let size = 0;
    request.on('data', (chunk) => {
      size += chunk.length;
      if (size > 8 * 1024 * 1024) request.destroy();
      else chunks.push(chunk);
    });
    request.on('end', () => {
      let body;
      try {
        body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
      } catch {
        reply(400, { error: 'not JSON' });
        return;
      }
      if (!this.sessionId || body.sessionId !== this.sessionId) {
        // A thread the bar is not, or is no longer, talking to.
        reply(200, { unlink: true });
        return;
      }
      if (request.url === '/poll') this.#poll(body, reply, response);
      else if (request.url === '/event') {
        this.#event(body);
        reply(200, {});
      } else reply(404, { error: 'unknown' });
    });
  }

  #poll(body, reply, response) {
    this.#release({});
    this.modVersion = body.version ?? null;
    if (!this.listening) {
      const back = this.saidOffline;
      this.listening = true;
      this.saidOffline = false;
      this.busy = body.isBusy === true;
      this.emit('ready', { sessionId: this.sessionId, model: this.model, cwd: this.cwd });
      if (this.expectedVersion && this.modVersion !== this.expectedVersion) {
        this.emit('notice', { message: 'This thread runs an older Ember mod. Restart the thread to update it.' });
      } else if (back) this.emit('notice', { message: 'The thread is listening again' });
      if (this.busy) this.emit('turn-started', {});
    }
    const waiter = {
      reply,
      timer: setTimeout(() => {
        if (this.waiter === waiter) this.#release({});
      }, this.pollHoldMs),
    };
    response.on('close', () => {
      // The thread hung up without an answer: most likely its process ended.
      if (this.waiter === waiter) {
        clearTimeout(waiter.timer);
        this.waiter = null;
        this.idleSince = this.now();
      }
    });
    this.waiter = waiter;
    this.#flush();
  }

  // Answers the mod's open poll, if there is one.
  #release(body) {
    const waiter = this.waiter;
    if (!waiter) return false;
    this.waiter = null;
    this.idleSince = this.now();
    clearTimeout(waiter.timer);
    waiter.reply(200, body);
    return true;
  }

  #flush() {
    if (!this.queue.length || !this.waiter) return;
    const say = this.queue.splice(0);
    for (const item of say) this.sent.set(item.id, item);
    this.#release({ say: say.map(({ id, text }) => ({ id, text })) });
  }

  #event(event) {
    switch (event.type) {
      case 'submitted':
        this.sent.delete(event.id);
        // Your words are in the thread now.
        this.emit('delivered', { id: event.id });
        break;
      case 'dropped': {
        const item = this.sent.get(event.id);
        this.sent.delete(event.id);
        this.busy = false;
        if (item && isRetryable(event.reason)) {
          this.held.push(item);
          this.emit('error', { message: STOPPED_HELP });
        } else {
          this.emit('error', { message: `The thread did not take that: ${event.reason}` });
        }
        break;
      }
      case 'turn-start':
        this.busy = true;
        this.emit('turn-started', {});
        this.emit('thinking', {});
        break;
      case 'progress':
        // Text Claude wrote while still working, spoken as it comes.
        if (!this.skipReply && typeof event.text === 'string' && event.text) this.emit('progress', { text: event.text });
        break;
      case 'turn-complete': {
        this.busy = this.queue.length > 0 || this.sent.size > 0;
        const failed = event.reason === 'error' || event.reason === 'refusal';
        const quiet = this.skipReply || event.reason === 'aborted';
        this.skipReply = false;
        const text = failed
          ? 'Claude could not finish that turn. The thread has the details.'
          : quiet
            ? ''
            : String(event.text ?? '');
        // `spoken`: the reply was already spoken piece by piece as progress.
        this.emit('done', { text, isError: failed, streamed: false, spoken: event.spoken === true && !failed });
        // The stopped turn itself also ends; nothing was typed yet, so wait.
        if (event.reason !== 'aborted') this.#retryHeld();
        break;
      }
      default:
        break;
    }
  }

  // Something was typed in the thread since the stop, so try again.
  #retryHeld() {
    if (!this.held.length) return;
    const fresh = this.held.filter((item) => this.now() - item.at <= this.retryMaxAgeMs);
    this.held = [];
    if (!fresh.length) return;
    this.busy = true;
    this.queue.push(...fresh);
    this.#flush();
  }
}
