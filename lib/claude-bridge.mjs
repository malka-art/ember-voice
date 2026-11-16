// Keeps one Claude Code session open through the Agent SDK and turns its
// message stream into simple events for the widget.
//
// Events:
//   ready       { sessionId, model, cwd }   sessionId is null for a new session
//   session     { sessionId }               once the first turn has begun
//   signed-out  {}                          Claude Code has no sign-in here
//   thinking    {}
//   delta       { text }
//   tool        { name, label }
//   permission  { id, toolName, detail }
//   permission-cleared { id }
//   done        { text, isError }
//   error       { message }
//   closed      {}

import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';

import { withoutHostSession } from './env.mjs';

const TOOL_LABELS = {
  Read: 'Reading a file',
  Glob: 'Looking for files',
  Grep: 'Searching the code',
  Edit: 'Editing a file',
  Write: 'Writing a file',
  Bash: 'Running a command',
  WebSearch: 'Searching the web',
  WebFetch: 'Reading a web page',
  Agent: 'Handing work to a helper',
  Task: 'Handing work to a helper',
  TodoWrite: 'Updating the task list',
};

export function toolLabel(name) {
  if (TOOL_LABELS[name]) return TOOL_LABELS[name];
  if (name?.startsWith('mcp__')) return `Using ${name.split('__')[1] ?? 'a connected tool'}`;
  return `Using ${name}`;
}

export function describeToolCall(toolName, input = {}) {
  const pick =
    input.command ?? input.file_path ?? input.path ?? input.url ?? input.pattern ?? input.query ?? input.description;
  const detail = typeof pick === 'string' ? pick : JSON.stringify(input);
  return detail.length > 160 ? `${detail.slice(0, 157)}...` : detail;
}

// An async queue the SDK reads user turns from. Keeping it open keeps the
// session process warm between turns.
function createInbox() {
  const items = [];
  let wake = null;
  let closed = false;
  return {
    push(item) {
      items.push(item);
      wake?.();
    },
    close() {
      closed = true;
      wake?.();
    },
    async *[Symbol.asyncIterator]() {
      for (;;) {
        while (items.length) yield items.shift();
        if (closed) return;
        await new Promise((resolve) => (wake = resolve));
        wake = null;
      }
    },
  };
}

export function buildEnv(base, { useApiKey }) {
  const env = { ...withoutHostSession(base), CLAUDE_AGENT_SDK_CLIENT_APP: 'ember-voice/1.0.0' };
  // Without these the session signs in the way Claude Code does, with the
  // account already logged in on this machine.
  if (!useApiKey) {
    delete env.ANTHROPIC_API_KEY;
    delete env.ANTHROPIC_AUTH_TOKEN;
  }
  delete env.ELECTRON_RUN_AS_NODE;
  return env;
}

export class ClaudeBridge extends EventEmitter {
  constructor(config, { sdk } = {}) {
    super();
    this.config = config;
    this.sdk = sdk;
    this.query = null;
    this.inbox = null;
    this.pending = new Map();
    this.sessionId = null;
    this.cwd = null;
    this.model = config.model;
    this.busy = false;
    this.generation = 0;
    this.announced = false;
  }

  async #loadSdk() {
    this.sdk ??= await import('@anthropic-ai/claude-agent-sdk');
    return this.sdk;
  }

  // fork: talk in a copy of the session, leaving the original untouched.
  async start({ sessionId = null, cwd = process.cwd(), fork = false } = {}) {
    await this.stop();
    const { query } = await this.#loadSdk();
    const generation = ++this.generation;

    this.sessionId = sessionId;
    this.cwd = cwd;
    this.inbox = createInbox();

    const options = {
      cwd,
      model: this.model,
      includePartialMessages: true,
      permissionMode: 'default',
      settingSources: ['user', 'project', 'local'],
      systemPrompt: { type: 'preset', preset: 'claude_code', append: this.config.spokenStyle },
      env: buildEnv(process.env, this.config),
      canUseTool: (toolName, input, { signal }) => this.#askPermission(toolName, input, signal),
      stderr: (data) => this.emit('log', data),
    };
    if (sessionId) {
      options.resume = sessionId;
      if (fork) options.forkSession = true;
    }

    this.query = query({ prompt: this.inbox, options });
    this.announced = false;
    this.#pump(this.query, generation);
    this.#announce(this.query, generation);
  }

  // Claude Code only reports a session's id once its first turn begins, so
  // "ready" cannot wait for that or nobody could ever speak first. The
  // start-up handshake answers straight away and also says whether this
  // computer is signed in.
  async #announce(query, generation) {
    if (typeof query.initializationResult !== 'function') return;
    try {
      const init = await query.initializationResult();
      if (generation !== this.generation) return;
      if (isSignedOut(init?.account)) {
        this.emit('signed-out', {});
        return;
      }
      this.#ready();
    } catch (error) {
      if (generation !== this.generation) return;
      this.emit('error', { message: explainError(error) });
    }
  }

  #ready() {
    if (this.announced) return;
    this.announced = true;
    this.emit('ready', { sessionId: this.sessionId, model: this.model, cwd: this.cwd });
  }

  async #pump(query, generation) {
    let spoke = false;
    let failed = false;
    try {
      for await (const message of query) {
        if (generation !== this.generation) return;

        if (message.type === 'system' && message.subtype === 'init') {
          this.sessionId = message.session_id;
          this.emit('session', { sessionId: this.sessionId });
          this.#ready();
          continue;
        }

        // Ignore the inner chatter of helper agents; only the main thread is spoken.
        if (message.parent_tool_use_id) continue;

        if (message.type === 'stream_event') {
          const event = message.event;
          if (event.type === 'message_start') {
            this.emit('thinking', {});
          } else if (event.type === 'content_block_start' && event.content_block?.type === 'tool_use') {
            const name = event.content_block.name;
            this.emit('tool', { name, label: toolLabel(name) });
          } else if (event.type === 'content_block_delta' && event.delta?.type === 'text_delta') {
            spoke = true;
            this.emit('delta', { text: event.delta.text });
          }
          continue;
        }

        if (message.type === 'assistant' && message.error) {
          failed = true;
          if (message.error === 'authentication_failed') this.emit('signed-out', {});
          else this.emit('error', { message: explainError(message.error) });
          continue;
        }

        if (message.type === 'result') {
          this.busy = false;
          const isError = message.subtype !== 'success' || message.is_error === true;
          const raw = typeof message.result === 'string' ? message.result : '';
          // A failure already reported above is not repeated as the reply.
          const text = failed ? '' : isError ? explainError(raw) : raw;
          this.emit('done', { text, isError, streamed: spoke });
          spoke = false;
          failed = false;
        }
      }
      if (generation === this.generation) this.emit('closed', {});
    } catch (error) {
      if (generation !== this.generation) return;
      this.busy = false;
      this.emit('error', { message: explainError(error) });
    }
  }

  send(text) {
    if (!this.inbox) throw new Error('No session is open.');
    this.busy = true;
    this.inbox.push({
      type: 'user',
      message: { role: 'user', content: text },
      parent_tool_use_id: null,
    });
  }

  async interrupt() {
    for (const id of [...this.pending.keys()]) this.answerPermission(id, false);
    if (!this.query || !this.busy) return;
    try {
      await this.query.interrupt();
    } catch {
      // The turn may already have ended.
    }
  }

  async setModel(model) {
    this.model = model;
    if (this.query) await this.query.setModel(model);
  }

  #askPermission(toolName, input, signal) {
    return new Promise((resolve) => {
      const id = randomUUID();
      const finish = (result) => {
        if (!this.pending.delete(id)) return;
        this.emit('permission-cleared', { id });
        resolve(result);
      };
      this.pending.set(id, { input, finish });
      signal?.addEventListener('abort', () =>
        finish({ behavior: 'deny', message: 'The request was cancelled.' }),
      );
      this.emit('permission', { id, toolName, label: toolLabel(toolName), detail: describeToolCall(toolName, input) });
    });
  }

  answerPermission(id, allow) {
    const entry = this.pending.get(id);
    if (!entry) return;
    entry.finish(
      allow
        ? { behavior: 'allow', updatedInput: entry.input }
        : { behavior: 'deny', message: 'Declined from the voice widget.' },
    );
  }

  async stop() {
    this.generation++;
    for (const id of [...this.pending.keys()]) this.answerPermission(id, false);
    this.inbox?.close();
    this.inbox = null;
    const query = this.query;
    this.query = null;
    this.busy = false;
    try {
      await query?.return?.();
    } catch {
      // Already finished.
    }
  }
}

// True when Claude Code on this computer has no sign-in at all: no plan
// login and no API key. Other providers handle their own sign-in.
//
// What Claude Code actually reports (checked 2026-11-12):
//   signed out        { tokenSource: 'none', apiProvider: 'firstParty' }
//   plan sign-in      { email, organization, subscriptionType, apiProvider: 'firstParty' }
// A plan sign-in carries no tokenSource at all, so a missing one means nothing.
export function isSignedOut(account) {
  if (!account) return false;
  if (account.apiProvider && account.apiProvider !== 'firstParty') return false;
  if (account.email || account.subscriptionType) return false;
  const none = (value) => !value || value === 'none';
  return account.tokenSource === 'none' && none(account.apiKeySource);
}

export const SIGN_IN_HELP = 'Claude Code is signed out on this computer. In a terminal, run "claude auth login", then click the orb.';

export function explainError(error) {
  const raw = typeof error === 'string' ? error : (error?.message ?? String(error));
  if (/authenticat|unauthor|not logged in|invalid api key|login|oauth/i.test(raw)) return SIGN_IN_HELP;
  if (/rate.?limit|usage limit|overloaded/i.test(raw)) {
    return `Claude is unavailable right now: ${raw}`;
  }
  if (/ENOENT|not found|spawn/i.test(raw)) {
    return `Claude Code could not start: ${raw}`;
  }
  return raw;
}
