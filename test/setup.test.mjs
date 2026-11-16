import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { DEFAULTS, loadConfig, LOCAL_CONFIG } from '../lib/config.mjs';
import { createTranscriber, pickWhisperModel, Transcriber, WhisperServer } from '../lib/stt.mjs';
import { VOICES } from '../lib/neural-voice.mjs';
import { VOICE_CHOICES } from '../lib/settings.mjs';
import { chooseModel, dataDirectory, download, KOKORO_VOICES, modelKey, parseSetupArgs, SPEECH_MODELS } from '../scripts/setup.mjs';

const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
const tempDir = () => mkdtempSync(path.join(os.tmpdir(), 'ember-setup-'));
const quiet = () => {};
const answer = (bytes) => async () => new Response(bytes);

test('config: the local file is laid over config.json, which is laid over the defaults', () => {
  const root = tempDir();
  try {
    writeFileSync(path.join(root, 'config.json'), JSON.stringify({ mode: 'thread', silenceMs: 1500 }));
    writeFileSync(path.join(root, LOCAL_CONFIG), JSON.stringify({ whisperDir: 'D:\\whisper', silenceMs: 900 }));
    const config = loadConfig(root);
    assert.equal(config.mode, 'thread');
    assert.equal(config.silenceMs, 900);
    assert.equal(config.whisperDir, 'D:\\whisper');
    assert.equal(config.ttsVoice, 'af_heart');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('config: a missing or broken local file is ignored', () => {
  const root = tempDir();
  try {
    writeFileSync(path.join(root, 'config.json'), JSON.stringify({ silenceMs: 1500 }));
    assert.equal(loadConfig(root).silenceMs, 1500);
    writeFileSync(path.join(root, LOCAL_CONFIG), '{ not json');
    assert.equal(loadConfig(root).silenceMs, 1500);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('config: the shared config.json names nothing about one PC', () => {
  const shared = readFileSync(new URL('../config.json', import.meta.url), 'utf8');
  assert.doesNotMatch(shared, /[A-Za-z]:\\\\|\\\\Users\\\\|OneDrive/);
});

test('hearing: with no folders configured, the app finds what setup put in the data folder', () => {
  const dataDir = tempDir();
  try {
    mkdirSync(path.join(dataDir, 'whisper'));
    mkdirSync(path.join(dataDir, 'speech-models'));
    writeFileSync(path.join(dataDir, 'whisper', 'whisper-server.exe'), '');
    writeFileSync(path.join(dataDir, 'speech-models', 'ggml-large-v3-turbo.bin'), '');
    const lines = [];
    const config = { ...DEFAULTS, whisperModel: 'ggml-large-v3-turbo.bin' };
    const engine = createTranscriber(config, { root: dataDir, dataDir, onLog: (line) => lines.push(line) });
    assert.ok(engine instanceof WhisperServer);
    assert.equal(engine.exe, path.join(dataDir, 'whisper', 'whisper-server.exe'));
    assert.equal(engine.model, path.join(dataDir, 'speech-models', 'ggml-large-v3-turbo.bin'));
    assert.deepEqual(lines, []);
    // %NAME% in a folder setting is filled in.
    process.env.EMBER_TEST_DIR = dataDir;
    const named = createTranscriber({ ...config, whisperDir: '%EMBER_TEST_DIR%\\whisper' }, { root: os.tmpdir(), dataDir, onLog: quiet });
    assert.equal(named.exe, path.join(dataDir, 'whisper', 'whisper-server.exe'));
  } finally {
    delete process.env.EMBER_TEST_DIR;
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test('hearing: with nothing set up, the built-in engine is used and the log says how to add the fast one', () => {
  const dataDir = tempDir();
  try {
    const lines = [];
    const engine = createTranscriber(DEFAULTS, { root: dataDir, dataDir, onLog: (line) => lines.push(line) });
    assert.ok(engine instanceof Transcriber);
    assert.match(lines.join('\n'), /npm run setup/);
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test('speech model: a plain file name is found in the speech-models folder', () => {
  const dirs = [path.join('C:', 'data', 'speech-models'), path.join('C:', 'whisper')];
  const small = path.join(dirs[0], 'ggml-small.en.bin');
  assert.deepEqual(pickWhisperModel('ggml-small.en.bin', { dirs, exists: (f) => f === small }), { model: small, wanted: small });
});

test('setup: options', () => {
  assert.deepEqual(parseSetupArgs([]), { cpu: false, model: null, hearing: true, voice: true, command: true });
  assert.equal(parseSetupArgs(['--model', 'base.en']).model, 'base.en');
  assert.equal(parseSetupArgs(['--model=ggml-large-v3-turbo.bin']).model, 'large-v3-turbo');
  assert.equal(parseSetupArgs(['--cpu']).cpu, true);
  assert.equal(parseSetupArgs(['--skip-voice', '--skip-hearing', '--skip-command']).voice, false);
  assert.throws(() => parseSetupArgs(['--model', 'tiny']), /unknown model/);
  assert.throws(() => parseSetupArgs(['--fast']), /unknown option/);
});

test('setup: model names', () => {
  assert.equal(modelKey('ggml-small.en.bin'), 'small.en');
  assert.equal(modelKey('C:\\models\\ggml-large-v3-turbo.bin'), 'large-v3-turbo');
  assert.equal(modelKey('ggml-tiny.bin'), null);
  assert.equal(modelKey(''), null);
  for (const pin of Object.values(SPEECH_MODELS)) assert.match(pin.sha256, /^[0-9a-f]{64}$/);
});

test('setup: which speech model it fetches', () => {
  assert.deepEqual(chooseModel({ flavor: 'cuda' }), { model: 'large-v3-turbo', remember: true });
  assert.deepEqual(chooseModel({ flavor: 'cpu' }), { model: 'base.en', remember: true });
  assert.deepEqual(chooseModel({ option: 'small.en', local: { whisperModel: 'ggml-base.en.bin' }, flavor: 'cuda' }), { model: 'small.en', remember: true });
  // This PC's own choice stands.
  assert.deepEqual(chooseModel({ local: { whisperModel: 'ggml-medium.en.bin' }, flavor: 'cpu' }), { model: 'medium.en', remember: false });
  // A full path is left alone, even to a model setup knows.
  const elsewhere = chooseModel({ local: { whisperModel: 'D:\\m\\ggml-small.en.bin' }, flavor: 'cpu' });
  assert.equal(elsewhere.model, null);
  assert.match(elsewhere.note, /points at D:\\m\\ggml-small\.en\.bin/);
  assert.equal(chooseModel({ local: { whisperModel: 'my-model.bin' }, flavor: 'cpu' }).model, null);
});

test('setup: every voice the app offers has a pinned file', () => {
  for (const voice of Object.keys(VOICES)) assert.match(KOKORO_VOICES[voice] ?? '', /^[0-9a-f]{64}$/, voice);
  for (const { id } of VOICE_CHOICES) assert.ok(KOKORO_VOICES[id], id);
});

test('setup: the data folder follows EMBER_USER_DATA, else %APPDATA%\\ember-voice', () => {
  assert.equal(dataDirectory({ APPDATA: 'C:\\Users\\x\\AppData\\Roaming' }), path.join('C:\\Users\\x\\AppData\\Roaming', 'ember-voice'));
  assert.equal(dataDirectory({ APPDATA: 'C:\\a', EMBER_USER_DATA: 'C:\\test\\data' }), path.resolve('C:\\test\\data'));
});

test('setup: a download that matches its checksum is put in place', async () => {
  const dir = tempDir();
  try {
    const bytes = Buffer.from('a speech model');
    const dest = path.join(dir, 'models', 'm.bin');
    const pin = { size: bytes.length, sha256: sha(bytes) };
    assert.equal(await download('https://x/m.bin', dest, { ...pin, label: 'm', fetchImpl: answer(bytes), log: quiet }), true);
    assert.deepEqual(readFileSync(dest), bytes);
    assert.equal(existsSync(`${dest}.download`), false);
    // Already there: nothing is fetched.
    const refuse = async () => assert.fail('should not download again');
    assert.equal(await download('https://x/m.bin', dest, { ...pin, label: 'm', fetchImpl: refuse, log: quiet }), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('setup: a download that does not match is deleted and never used', async () => {
  const dir = tempDir();
  try {
    const dest = path.join(dir, 'm.bin');
    const good = Buffer.from('the real file');
    const bad = Buffer.from('a swapped file');
    await assert.rejects(
      download('https://x/m.bin', dest, { size: good.length, sha256: sha(good), label: 'm', fetchImpl: answer(bad), log: quiet }),
      /did not match its pinned checksum/,
    );
    assert.equal(existsSync(dest), false);
    assert.equal(existsSync(`${dest}.download`), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('setup: a file already there but wrong is replaced', async () => {
  const dir = tempDir();
  try {
    const dest = path.join(dir, 'm.bin');
    const good = Buffer.from('the real file');
    writeFileSync(dest, 'half a fil');
    await download('https://x/m.bin', dest, { size: good.length, sha256: sha(good), label: 'm', fetchImpl: answer(good), log: quiet });
    assert.deepEqual(readFileSync(dest), good);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('setup: a failed request says so and leaves nothing behind', async () => {
  const dir = tempDir();
  try {
    const dest = path.join(dir, 'm.bin');
    const missing = async () => new Response('not found', { status: 404 });
    await assert.rejects(download('https://x/m.bin', dest, { size: 1, sha256: 'a'.repeat(64), label: 'm', fetchImpl: missing, log: quiet }), /answered 404/);
    assert.equal(existsSync(dest), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
