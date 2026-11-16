// A stand-in for the Claude session, used by "npm run preview" so the widget
// can be seen and heard without spending any usage.

import { EventEmitter } from 'node:events';

const REPLY =
  'This is the preview voice. The real widget sends what you say to your Claude Code session and reads the answer back as it arrives. ' +
  'Click the orb to cut a reply short, and use the buttons on the right to mute the mic or the voice.';

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export class MockBridge extends EventEmitter {
  constructor(config, { echo = false } = {}) {
    super();
    // In the mic test the stand-in repeats what it heard, so the microphone
    // and the speech model can be checked without spending any usage.
    this.echo = echo;
    this.model = config.model;
    this.sessionId = 'preview';
    this.cwd = process.cwd();
    this.busy = false;
    this.run = 0;
    this.pending = new Map();
  }

  async start({ cwd } = {}) {
    this.cwd = cwd ?? this.cwd;
    setTimeout(() => this.emit('ready', { sessionId: this.sessionId, model: this.model, cwd: this.cwd }), 50);
  }

  async send(text) {
    const run = ++this.run;
    this.busy = true;
    this.emit('thinking', {});
    await wait(900);
    if (run !== this.run) return;

    if (this.echo) {
      this.#speak(run, `I heard: ${text}`);
      return;
    }

    if (/permission|allow|command/i.test(text)) {
      this.emit('tool', { name: 'Bash', label: 'Running a command' });
      const allowed = await new Promise((resolve) => {
        this.pending.set('demo', resolve);
        this.emit('permission', { id: 'demo', toolName: 'Bash', label: 'Running a command', detail: 'npm test' });
      });
      this.emit('permission-cleared', { id: 'demo' });
      if (run !== this.run) return;
      if (!allowed) {
        this.#speak(run, 'Okay, I left that command alone.');
        return;
      }
    } else {
      this.emit('tool', { name: 'Read', label: 'Reading a file' });
      await wait(700);
      if (run !== this.run) return;
    }
    this.#speak(run, REPLY);
  }

  async #speak(run, reply) {
    for (const word of reply.split(/(?<= )/)) {
      if (run !== this.run) return;
      this.emit('delta', { text: word });
      await wait(45);
    }
    this.busy = false;
    this.emit('done', { text: reply, isError: false, streamed: true });
  }

  answerPermission(id, allow) {
    this.pending.get(id)?.(allow);
    this.pending.delete(id);
  }

  async interrupt() {
    this.run++;
    for (const id of [...this.pending.keys()]) this.answerPermission(id, false);
    if (this.busy) {
      this.busy = false;
      this.emit('done', { text: '', isError: false, streamed: true });
    }
  }

  async setModel(model) {
    this.model = model;
  }

  async stop() {
    this.run++;
  }
}
