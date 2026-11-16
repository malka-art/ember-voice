// Tests for the neural voice: the pure parts, the engine with a stand-in
// model, the window-side player with a stand-in audio device, and (only when
// the real model and phonemizer are on this computer) one real sentence.
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { normalizeText, phonemize } from '../lib/kokoro-phonemize.mjs';
import { NeuralSpeaker, piecesFor } from '../lib/neural-speaker.mjs';
import { encodeWav, isNeuralEngine, loadNeuralVoice, NeuralVoice, resolveModelDir, styleRow, ThreadedVoice, trimSilence } from '../lib/neural-voice.mjs';
import { splitForSpeech } from '../lib/speech-chunks.mjs';

test('short sentences are left whole', () => {
  assert.deepEqual(splitForSpeech('Done.'), ['Done.']);
  assert.deepEqual(splitForSpeech('  Want me to run   the tests? '), ['Want me to run the tests?']);
  assert.deepEqual(splitForSpeech(''), []);
});

test('long sentences break at punctuation first, then before joining words', () => {
  const s = 'I fixed the failing test, updated the config loader so it reads the new file, and pushed the change to your branch.';
  const pieces = splitForSpeech(s, { maxChars: 60 });
  assert.ok(pieces.length >= 2);
  assert.ok(pieces.every((p) => p.length <= 60), pieces.join(' | '));
  assert.equal(pieces.join(' '), s);
  assert.equal(pieces[0], 'I fixed the failing test,');

  const noCommas = 'I fixed the failing test and pushed the change to your branch so you can pull it now.';
  const cut = splitForSpeech(noCommas, { maxChars: 50 });
  assert.equal(cut.join(' '), noCommas);
  assert.match(cut[1], /^(and|so) /, cut.join(' | '));
});

test('each sentence is voiced whole, so it keeps one natural rise and fall', () => {
  const s = 'I fixed the failing test and pushed the change to your branch, so you can pull it whenever you are ready and run it.';
  assert.deepEqual(piecesFor(s, 0), [s]);

  // A whole reply arriving at once (thread mode): one piece per sentence,
  // never a cut mid-phrase, and nothing lost.
  const reply =
    'Done. The bar is connected, but its log shows this thread is still running the older plugin. ' +
    'The tests pass, and the bar is running on the test thread with the new voice. Want me to try a longer reply next?';
  assert.deepEqual(piecesFor(reply, 0), [
    'Done.',
    'The bar is connected, but its log shows this thread is still running the older plugin.',
    'The tests pass, and the bar is running on the test thread with the new voice.',
    'Want me to try a longer reply next?',
  ]);

  // Only a very long sentence is split, at its commas.
  const long = `${'This part goes on for quite a while, '.repeat(9)}and then it ends.`;
  const pieces = piecesFor(long, 0);
  assert.ok(pieces.length > 1);
  assert.ok(pieces.every((piece) => piece.length <= 280));
  assert.equal(pieces.join(' '), long);
});

test('style row follows the token count and stays in range', () => {
  assert.equal(styleRow(0), 0);
  assert.equal(styleRow(2), 0);
  assert.equal(styleRow(12), 10);
  assert.equal(styleRow(5000), 509);
});

test('text normalisation matches kokoro-js on numbers, money and titles', () => {
  assert.equal(normalizeText('Dr. Smith paid $5.50 at 3:05 in 1984.'), 'Doctor Smith paid 5 dollars and 50 cents at 3 oh 5 in 19 84.');
  assert.equal(normalizeText('Pages 10-12'), 'Pages 10 to 12');
});

test('phonemize keeps punctuation and passes words to espeak', async () => {
  const calls = [];
  const espeak = async (t, lang) => {
    calls.push([t, lang]);
    return [t.toLowerCase()];
  };
  const out = await phonemize('Hello, World!', espeak, 'a');
  assert.equal(out, 'hello, woɹld!');
  assert.deepEqual(calls, [['Hello', 'en-us'], ['World', 'en-us']]);
  await phonemize('Hi', espeak, 'b');
  assert.equal(calls.at(-1)[1], 'en');
});

test('silence padding is trimmed to a short margin, silence-only clips are kept', () => {
  const clip = new Float32Array(24000);
  clip.fill(0.5, 7200, 12000); // 0.3 s of silence, 0.2 s of sound, 0.5 s of silence
  const out = trimSilence(clip, { keepLeadMs: 10, keepTailMs: 50 });
  assert.equal(out.length, 240 + 4800 + 1200);
  assert.equal(out[240], 0.5);
  const quiet = new Float32Array(100);
  assert.equal(trimSilence(quiet), quiet);
});

test('wav header is valid 16-bit mono', () => {
  const wav = encodeWav(new Float32Array([0, 1, -1]), 24000);
  assert.equal(wav.toString('ascii', 0, 4), 'RIFF');
  assert.equal(wav.readUInt32LE(24), 24000);
  assert.equal(wav.readInt16LE(46), 32767);
  assert.equal(wav.readInt16LE(48), -32768);
});

// A stand-in for @huggingface/transformers: each run takes `delay` ms and
// returns as many samples as the text has characters.
function fakeTransformers({ delay = 5, fail = false } = {}) {
  const runs = [];
  class Tensor {
    constructor(type, data, dims) {
      Object.assign(this, { type, data, dims });
    }
  }
  return {
    runs,
    module: {
      env: {},
      Tensor,
      AutoTokenizer: {
        from_pretrained: async () => (text) => ({ input_ids: { dims: [1, text.length + 2], text } }),
      },
      StyleTextToSpeech2Model: {
        from_pretrained: async () => {
          if (fail) throw new Error('model file missing');
          const model = async ({ input_ids }) => {
            runs.push(input_ids.text);
            await new Promise((r) => setTimeout(r, delay));
            return { waveform: { data: new Float32Array(input_ids.text.length) } };
          };
          model.dispose = async () => {};
          return model;
        },
      },
    },
  };
}

function voiceDir() {
  const dir = mkdtempSync(path.join(tmpdir(), 'ember-voice-'));
  writeFileSync(path.join(dir, 'af_heart.bin'), Buffer.alloc(510 * 256 * 4));
  return dir;
}

function fakeVoice(options = {}) {
  const fake = fakeTransformers(options);
  const voice = new NeuralVoice({
    voicesDir: voiceDir(),
    allowDownload: true, // the stand-in model has no files to check
    importTransformers: async () => fake.module,
    importPhonemizer: async () => ({ phonemize: async (t) => [t] }),
  });
  return { voice, fake };
}

test('sentences are made one at a time, in order', async () => {
  const { voice, fake } = fakeVoice();
  await voice.load();
  fake.runs.length = 0;
  const clips = await Promise.all(['one.', 'two two.', 'ten ten ten.'].map((t) => voice.synthesize(t)));
  assert.deepEqual(fake.runs, ['one.', 'two two.', 'ten ten ten.']);
  assert.deepEqual(clips.map((c) => c.samples.length), [4, 8, 12]);
  assert.equal(clips[0].sampleRate, 24000);
});

test('stop drops queued sentences and the one being made', async () => {
  const { voice, fake } = fakeVoice({ delay: 30 });
  await voice.load();
  fake.runs.length = 0;
  const jobs = ['a.', 'b.', 'c.'].map((t) => voice.synthesize(t));
  await new Promise((r) => setTimeout(r, 5));
  voice.stop();
  assert.deepEqual(await Promise.all(jobs), [null, null, null]);
  assert.deepEqual(fake.runs, ['a.'], 'nothing after the running sentence starts');
  const after = await voice.synthesize('again.');
  assert.ok(after, 'works again after a stop');
});

test('a voice that cannot load reports why, so the Windows voice is used', async () => {
  const lines = [];
  const fake = fakeTransformers({ fail: true });
  const { voice, reason } = await loadNeuralVoice(
    { ttsEngine: 'kokoro', ttsModelDir: voiceDir() },
    { onLog: (l) => lines.push(l), allowDownload: true, importTransformers: async () => fake.module, importPhonemizer: async () => ({ phonemize: async (t) => [t] }) },
  );
  assert.equal(voice, null);
  assert.match(reason, /could not load \(model file missing\); using the Windows voice/);
  assert.deepEqual(lines, [reason]);
  const missing = await loadNeuralVoice({ ttsEngine: 'kokoro', ttsModelDir: voiceDir() }, { importTransformers: async () => fake.module });
  assert.match(missing.reason, /model files not found: .*model\.onnx/);
  const off = await loadNeuralVoice({ ttsEngine: 'windows' });
  assert.equal(off.voice, null);
});

// Stand-in Web Audio: records what starts and stops, and ends a source when
// the test says so.
function fakeAudio() {
  const log = [];
  const ctx = {
    currentTime: 0,
    state: 'running',
    destination: {},
    createBuffer: (_ch, length, rate) => ({ duration: length / rate, copyToChannel() {} }),
    createGain: () => ({ gain: {}, connect: (d) => d }),
    createBufferSource() {
      const source = {
        connect: (g) => g,
        start: (at) => log.push(['start', at]),
        stop: () => log.push(['stop']),
        end: () => source.onended?.(),
      };
      log.push(['source', source]);
      return source;
    },
  };
  return { ctx, log };
}

function fakeFallback() {
  const said = [];
  return { said, speaking: false, say: (t) => said.push(t), cancel() {}, setEnabled() {} };
}

const tick = () => new Promise((r) => setTimeout(r, 0));

test('player plays pieces back to back and reports speaking until the last ends', async () => {
  const { ctx, log } = fakeAudio();
  const lines = [];
  const player = new NeuralSpeaker({
    synth: async (t) => ({ samples: new Float32Array(24000), sampleRate: 24000, ms: 1 }),
    fallback: fakeFallback(),
    audioContext: ctx,
    onLog: (l) => lines.push(l),
  });
  player.feed('First sentence. Second ');
  player.feed('sentence.');
  player.finish();
  await tick();
  await tick();
  const starts = log.filter((e) => e[0] === 'start').map((e) => e[1]);
  assert.equal(starts.length, 2);
  assert.ok(starts[1] >= starts[0] + 1, 'second starts after the first second of audio');
  assert.equal(player.speaking, true);
  const sources = log.filter((e) => e[0] === 'source').map((e) => e[1]);
  sources[0].end();
  assert.equal(player.speaking, true);
  sources[1].end();
  assert.equal(player.speaking, false);
  // main.mjs restarts the no-name listening window from exactly this line.
  assert.deepEqual(lines.filter((l) => l.startsWith('spoke ')).map((l) => l.replace(/\d+ ms$/, 'N ms')), ['spoke 15 characters in N ms', 'spoke 16 characters in N ms']);
});

test('cancel stops the playing audio at once and tells the engine to stop', async () => {
  const { ctx, log } = fakeAudio();
  let stops = 0;
  let release;
  const slow = new Promise((r) => (release = r));
  const player = new NeuralSpeaker({
    synth: async (t) => (t.startsWith('Later') ? slow : { samples: new Float32Array(2400), sampleRate: 24000 }),
    stopSynth: () => stops++,
    fallback: fakeFallback(),
    audioContext: ctx,
  });
  player.say('Now.');
  player.say('Later piece.');
  await tick();
  player.cancel();
  assert.deepEqual(log.filter((e) => e[0] !== 'source').map((e) => e[0]), ['start', 'stop']);
  assert.equal(stops, 1);
  assert.equal(player.speaking, false);
  release({ samples: new Float32Array(2400), sampleRate: 24000 });
  await tick();
  await tick();
  assert.equal(log.filter((e) => e[0] === 'start').length, 1, 'a piece made after the cancel is never played');
});

test('player hands over to the Windows voice when the neural voice fails', async () => {
  const lines = [];
  const fallback = fakeFallback();
  const player = new NeuralSpeaker({
    synth: async () => {
      throw new Error('neural voice unavailable');
    },
    fallback,
    audioContext: fakeAudio().ctx,
    onLog: (l) => lines.push(l),
  });
  player.say('One.');
  player.say('Two.');
  await tick();
  await tick();
  player.say('Three.');
  assert.deepEqual(fallback.said, ['One.', 'Two.', 'Three.']);
  assert.equal(lines.length, 1);
  assert.match(lines[0], /switching to the Windows voice/);
});

test('model folder setting expands %NAME% and falls back to the default', () => {
  const env = { APPDATA: 'C:\\Users\\x\\AppData\\Roaming' };
  assert.equal(resolveModelDir('%APPDATA%\\ember-voice\\voice-models', { env }), path.resolve('C:\\Users\\x\\AppData\\Roaming\\ember-voice\\voice-models'));
  assert.equal(resolveModelDir('', { defaultDir: 'D:\\models' }), 'D:\\models');
  assert.equal(isNeuralEngine('neural'), true);
  assert.equal(isNeuralEngine('kokoro'), true);
  assert.equal(isNeuralEngine('windows'), false);
});

// The real model: runs only where the bar's model folder holds it.
const MODEL_DIR = path.join(process.env.APPDATA || '', 'ember-voice', 'voice-models');
const realReady =
  existsSync(path.join(MODEL_DIR, 'voices', 'af_heart.bin')) &&
  existsSync(path.join(MODEL_DIR, 'onnx-community', 'Kokoro-82M-v1.0-ONNX', 'onnx', 'model.onnx'));

test('real Kokoro model speaks, and the speed setting changes the pace', { skip: realReady ? false : 'model not on this computer' }, async (t) => {
  const { voice, reason } = await loadNeuralVoice({ ttsEngine: 'neural', ttsModelDir: MODEL_DIR });
  assert.equal(reason, null);
  t.after(() => voice.dispose());
  assert.ok(voice instanceof ThreadedVoice, 'runs on its own thread');
  const text = 'The tests pass, and the bar is running on the test thread.';
  // The caller's thread must stay free while the voice is made.
  let last = performance.now();
  let worst = 0;
  const timer = setInterval(() => {
    const now = performance.now();
    worst = Math.max(worst, now - last - 10);
    last = now;
  }, 10);
  const normal = await voice.synthesize(text, { speed: 1 });
  clearInterval(timer);
  assert.ok(worst < 150, `caller stalled ${Math.round(worst)} ms`);
  const faster = await voice.synthesize(text, { speed: 1.15 });
  // stop() answers everything still asked for with null at once.
  const dropped = voice.synthesize(text);
  voice.stop();
  assert.equal(await dropped, null);
  const seconds = normal.samples.length / normal.sampleRate;
  assert.ok(seconds > 2 && seconds < 6, `a few seconds of audio, got ${seconds}`);
  const peak = normal.samples.reduce((m, v) => Math.max(m, Math.abs(v)), 0);
  assert.ok(peak > 0.05, 'not silent');
  const ratio = normal.samples.length / faster.samples.length;
  assert.ok(ratio > 1.03 && ratio < 1.25, `1.15 should be shorter (measured: about 8%), got x${ratio.toFixed(3)}`);
  await voice.dispose();
});