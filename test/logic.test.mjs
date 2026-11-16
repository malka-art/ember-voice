import test from 'node:test';
import assert from 'node:assert/strict';
import { VoiceDetector } from '../lib/vad.mjs';
import { SentenceStream, cleanForSpeech } from '../lib/speech-text.mjs';
import { parseArgs, resolveTarget, sessionTitle } from '../lib/sessions.mjs';
import { ClaudeBridge, buildEnv, explainError, isSignedOut } from '../lib/claude-bridge.mjs';
import path from 'node:path';
import { cleanTranscript, encodeWav, keepUsers, pickWhisperModel } from '../lib/stt.mjs';
import { withoutHostSession } from '../lib/env.mjs';

const frame = (amp) => Float32Array.from({ length: 512 }, (_, i) => amp * Math.sin(i / 3));
const feed = (vad, amp, ms) => {
  const events = [];
  for (let t = 0; t < ms; t += 32) { const e = vad.push(frame(amp)); if (e) events.push(e); }
  return events;
};

test('vad: speech between silences becomes one utterance with pre-roll', () => {
  const vad = new VoiceDetector({ silenceMs: 800 });
  assert.deepEqual(feed(vad, 0.001, 1000), []);
  const during = feed(vad, 0.2, 1500);
  assert.equal(during[0].type, 'start');
  const after = feed(vad, 0.001, 1000);
  assert.equal(after.length, 1);
  assert.equal(after[0].type, 'end');
  const seconds = after[0].audio.length / 16000;
  assert.ok(seconds > 2.3 && seconds < 2.9, `utterance was ${seconds}s`);
});

test('vad: a short click is discarded, steady hum is not speech', () => {
  const vad = new VoiceDetector();
  feed(vad, 0.001, 500);
  const events = [...feed(vad, 0.3, 130), ...feed(vad, 0.001, 1000)];
  assert.deepEqual(events.map((e) => e.type), ['start', 'discard']);
  const hum = new VoiceDetector();
  assert.deepEqual(feed(hum, 0.006, 5000), []);
});

test('vad: a pause shorter than the limit does not split the sentence', () => {
  const vad = new VoiceDetector({ silenceMs: 800 });
  feed(vad, 0.001, 500);
  const events = [...feed(vad, 0.2, 800), ...feed(vad, 0.001, 500), ...feed(vad, 0.2, 800), ...feed(vad, 0.001, 1000)];
  assert.deepEqual(events.map((e) => e.type), ['start', 'end']);
});

test('sentences: streamed text is cut at sentence ends', () => {
  const s = new SentenceStream();
  const out = [];
  for (const piece of ['Hello th', 'ere. Version 3.5 is ou', 't! Is it', ' good? Maybe']) out.push(...s.feed(piece));
  assert.deepEqual(out, ['Hello there.', 'Version 3.5 is out!', 'Is it good?']);
  assert.deepEqual(s.flush(), ['Maybe']);
});

test('sentences: code blocks and markdown are not read aloud', () => {
  const s = new SentenceStream();
  const out = [...s.feed('Here is the **fix**:\n\n```js\nconst a = 1. \nfoo();\n```\n\nDone. '), ...s.flush()];
  assert.deepEqual(out, ['Here is the fix:', '(code omitted)', 'Done.']);
  assert.equal(cleanForSpeech('See [the docs](https://x.y/z) and `npm test`.'), 'See the docs and npm test.');
  const list = new SentenceStream();
  assert.deepEqual([...list.feed('1. First thing. 2. Second thing. '), ...list.flush()], ['1. First thing.', '2. Second thing.']);
});

test('args: session ids are validated', () => {
  assert.equal(parseArgs(['.', '--session', '736848ea-e359-4f8c-9e44-7f2dea2ad9b1']).session, '736848ea-e359-4f8c-9e44-7f2dea2ad9b1');
  assert.equal(parseArgs(['--session=abc; rm -rf /']).session, null);
  assert.deepEqual(parseArgs(['--new', '--cwd', 'C:/x']), { session: null, cwd: 'C:/x', fresh: true, latest: false, mock: false, micTest: false, quit: false });
  assert.equal(parseArgs(['--session', '${CLAUDE_SESSION_ID}']).session, null);
  const micTest = parseArgs(['--mic-test']);
  assert.deepEqual([micTest.mock, micTest.micTest], [true, true]);
});

test('target: named session wins; a plain start is new; --latest picks here, then anywhere', async () => {
  const sdk = (here, anywhere) => ({
    getSessionInfo: async (id) => ({ sessionId: id, summary: 'Fix the login bug', cwd: 'C:/proj' }),
    listSessions: async ({ dir }) => (dir ? here : anywhere),
  });
  const a = await resolveTarget({ session: 'abcdef12' }, sdk([], []), 'C:/x');
  assert.deepEqual([a.sessionId, a.cwd, a.title, a.source], ['abcdef12', 'C:/proj', 'Fix the login bug', 'named']);
  const here = [{ sessionId: 's1', summary: 'Here', cwd: 'C:/x' }];
  const plain = await resolveTarget({}, sdk(here, [{ sessionId: 's2', summary: 'Else' }]), 'C:/x');
  assert.deepEqual([plain.sessionId, plain.source], [null, 'new']);
  const b = await resolveTarget({ latest: true }, sdk(here, [{ sessionId: 's2', summary: 'Else' }]), 'C:/x');
  assert.equal(b.sessionId, 's1');
  const c = await resolveTarget({ latest: true }, sdk([], [{ sessionId: 's2', summary: 'Else', cwd: 'C:/y' }]), 'C:/x');
  assert.deepEqual([c.sessionId, c.cwd], ['s2', 'C:/y']);
  const d = await resolveTarget({ latest: true }, sdk([], []), 'C:/x');
  assert.equal(d.sessionId, null);
  const e = await resolveTarget({ fresh: true, latest: true }, sdk([{ sessionId: 's1' }], []), 'C:/x');
  assert.equal(e.sessionId, null);
  assert.equal(sessionTitle({ summary: 'x'.repeat(80) }).length, 60);
});

test('env: API keys are removed so the plan login is used', () => {
  const env = buildEnv({ ANTHROPIC_API_KEY: 'k', ANTHROPIC_AUTH_TOKEN: 't', PATH: 'p' }, { useApiKey: false });
  assert.equal(env.ANTHROPIC_API_KEY, undefined);
  assert.equal(env.ANTHROPIC_AUTH_TOKEN, undefined);
  assert.equal(env.PATH, 'p');
  assert.equal(buildEnv({ ANTHROPIC_API_KEY: 'k' }, { useApiKey: true }).ANTHROPIC_API_KEY, 'k');
  assert.match(explainError(new Error('Invalid API key · Please run /login')), /signed out/);
  assert.match(explainError('Failed to authenticate: OAuth session expired and could not be refreshed'), /signed out/);
  assert.equal(isSignedOut({ tokenSource: 'none', apiProvider: 'firstParty' }), true);
  assert.equal(isSignedOut({ email: 'a@b.c', organization: 'o', subscriptionType: 'Claude Ultra', apiProvider: 'firstParty' }), false);
  assert.equal(isSignedOut({ apiProvider: 'firstParty' }), false);
  assert.equal(isSignedOut({ tokenSource: 'none', apiKeySource: 'ANTHROPIC_API_KEY', apiProvider: 'firstParty' }), false);
  assert.equal(isSignedOut({ apiProvider: 'bedrock' }), false);
});

test('bridge: a signed-out computer is reported, and is not treated as ready', async () => {
  const fakeSdk = {
    query({ prompt }) {
      const gen = (async function* () {
        for await (const turn of prompt) yield { type: 'result', subtype: 'success', is_error: false, result: String(turn) };
      })();
      gen.initializationResult = async () => ({ account: { tokenSource: 'none', apiProvider: 'firstParty' } });
      return gen;
    },
  };
  const bridge = new ClaudeBridge({ model: 'm', spokenStyle: '', useApiKey: false, forkSession: false }, { sdk: fakeSdk });
  const seen = [];
  for (const n of ['ready', 'signed-out', 'error']) bridge.on(n, () => seen.push(n));
  const told = new Promise((resolve) => bridge.on('signed-out', resolve));
  await bridge.start({ cwd: '/tmp' });
  await told;
  assert.deepEqual(seen, ['signed-out']);
  await bridge.stop();
});

test('bridge: resumes the session, streams text, handles permission and model switch', async () => {
  let captured;
  const fakeSdk = {
    query({ prompt, options }) {
      captured = options;
      const gen = (async function* () {
        yield { type: 'system', subtype: 'init', session_id: 'sess-1', model: options.model };
        for await (const turn of prompt) {
          yield { type: 'stream_event', parent_tool_use_id: null, event: { type: 'message_start' } };
          yield { type: 'stream_event', parent_tool_use_id: 'sub', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'HIDDEN' } } };
          yield { type: 'stream_event', parent_tool_use_id: null, event: { type: 'content_block_start', content_block: { type: 'tool_use', name: 'Bash' } } };
          const verdict = await options.canUseTool('Bash', { command: 'npm test' }, { signal: new AbortController().signal });
          const reply = `${turn.message.content} -> ${verdict.behavior}`;
          yield { type: 'stream_event', parent_tool_use_id: null, event: { type: 'content_block_delta', delta: { type: 'text_delta', text: reply } } };
          yield { type: 'result', subtype: 'success', is_error: false, result: reply };
        }
      })();
      gen.interrupt = async () => {};
      gen.setModel = async (m) => { gen.model = m; };
      return gen;
    },
  };
  const bridge = new ClaudeBridge({ model: 'claude-opus-5-5', spokenStyle: 'Be brief.', useApiKey: false, forkSession: false }, { sdk: fakeSdk });
  const seen = [];
  for (const n of ['ready', 'thinking', 'delta', 'tool', 'permission', 'permission-cleared', 'done']) bridge.on(n, (p) => seen.push([n, p]));
  bridge.on('permission', ({ id }) => bridge.answerPermission(id, true));
  const done = new Promise((resolve) => bridge.on('done', resolve));
  await bridge.start({ sessionId: 'sess-1', cwd: '/tmp' });
  bridge.send('hi');
  const result = await done;
  assert.equal(captured.resume, 'sess-1');
  assert.equal(captured.forkSession, undefined);
  assert.equal(captured.model, 'claude-opus-5-5');
  assert.equal(captured.systemPrompt.append, 'Be brief.');
  assert.deepEqual(captured.settingSources, ['user', 'project', 'local']);
  assert.deepEqual(seen.map(([n]) => n), ['ready', 'thinking', 'tool', 'permission', 'permission-cleared', 'delta', 'done']);
  assert.equal(result.text, 'hi -> allow');
  assert.equal(seen.find(([n]) => n === 'permission')[1].detail, 'npm test');
  assert.ok(!seen.some(([, p]) => p.text === 'HIDDEN'));
  await bridge.setModel('claude-fable-5-2');
  assert.equal(bridge.query.model, 'claude-fable-5-2');
  await bridge.start({ sessionId: 'sess-1', cwd: '/tmp', fork: true });
  assert.deepEqual([captured.resume, captured.forkSession], ['sess-1', true]);
  await bridge.stop();
});

test('env: a launching session does not leak into the widget session', () => {
  const inside = withoutHostSession({
    CLAUDECODE: '1',
    CLAUDE_CODE_SESSION_ID: 'abc',
    CLAUDE_AGENT_SDK_VERSION: '1',
    ANTHROPIC_BASE_URL: 'http://127.0.0.1:1',
    CLAUDE_CONFIG_DIR: 'C:/cfg',
    ELECTRON_RUN_AS_NODE: '1',
    PATH: 'p',
  });
  assert.deepEqual(inside, { CLAUDE_CONFIG_DIR: 'C:/cfg', PATH: 'p' });
  // Outside a session the person's own settings are left alone.
  const outside = withoutHostSession({ ANTHROPIC_BASE_URL: 'https://proxy', CLAUDE_CODE_USE_BEDROCK: '1', ELECTRON_RUN_AS_NODE: '1' });
  assert.deepEqual(outside, { ANTHROPIC_BASE_URL: 'https://proxy', CLAUDE_CODE_USE_BEDROCK: '1' });
});

test('wav: speech is packed as 16 kHz mono 16-bit', () => {
  const wav = encodeWav(Float32Array.from([0, 1, -1, 0.5, 2]));
  assert.equal(wav.length, 44 + 10);
  assert.equal(wav.toString('ascii', 0, 4) + wav.toString('ascii', 8, 12), 'RIFFWAVE');
  assert.deepEqual([wav.readUInt16LE(22), wav.readUInt32LE(24), wav.readUInt16LE(34), wav.readUInt32LE(40)], [1, 16000, 16, 10]);
  assert.deepEqual([0, 1, 2, 3, 4].map((i) => wav.readInt16LE(44 + i * 2)), [0, 32767, -32768, 16384, 32767]);
});

test('shared speech server: the leaving bar and bars that are gone are dropped', () => {
  const users = [
    { pid: 10, program: 'electron.exe' },
    { pid: 11, program: 'electron.exe' },
    { pid: 12, program: 'electron.exe' },
    { pid: 11, program: 'electron.exe' },
    { pid: 'x' },
    null,
  ];
  const kept = keepUsers(users, { leaving: 10, running: (u) => u.pid !== 12 });
  assert.deepEqual(kept, [{ pid: 11, program: 'electron.exe' }]);
  assert.deepEqual(keepUsers(undefined, { leaving: 1, running: () => true }), []);
  assert.deepEqual(keepUsers([{ pid: 5, program: 'electron.exe' }], { leaving: 5, running: () => true }), []);
});

test('speech model: a missing model falls back to the best one on this computer', () => {
  const dirs = [path.join('C:', 'data', 'speech-models'), path.join('C:', 'whisper')];
  const on = (...files) => ({ dirs, exists: (f) => files.includes(f) });
  const turbo = path.join(dirs[0], 'ggml-large-v3-turbo.bin');
  const small = path.join(dirs[0], 'ggml-small.en.bin');
  const base = path.join(dirs[1], 'ggml-base.en.bin');
  // The configured one, when it is there.
  assert.deepEqual(pickWhisperModel(small, on(small, turbo)), { model: small, wanted: small });
  // Missing: the best that is there, in order.
  assert.equal(pickWhisperModel(turbo, on(small, base)).model, small);
  assert.equal(pickWhisperModel(turbo, on(base)).model, base);
  assert.equal(pickWhisperModel('ggml-medium.en.bin', on(base, turbo)).model, turbo);
  // A plain file name is looked for in the whisper.cpp folder.
  assert.equal(pickWhisperModel('ggml-base.en.bin', on(base)).wanted, base);
  // Nothing at all: the built-in engine takes over.
  assert.equal(pickWhisperModel(turbo, on()).model, null);
});

test('transcript: silence phrases are dropped', () => {
  assert.equal(cleanTranscript(' [BLANK_AUDIO] '), '');
  assert.equal(cleanTranscript('Thank you.'), '');
  assert.equal(cleanTranscript('  open the  readme '), 'open the readme');
});
