// A natural-sounding local voice: Kokoro-82M (Apache-2.0, hexgrad), run
// through ONNX Runtime by the @huggingface/transformers package this app
// already uses for speech to text. Nothing leaves the computer once the model
// files are on disk.
//
// Interface, small on purpose so the bar can call it from the main process:
//   const voice = new NeuralVoice(options)
//   await voice.load()                       once; throws if the model cannot load
//   const clip = await voice.synthesize(text) { samples: Float32Array, sampleRate, ms }
//                                            or null if stop() was called meanwhile
//   voice.stop()                             drops queued and running sentences
//   voice.dispose()
//
// Sentences are synthesised one at a time in the order asked, so a reply
// keeps its order and two runs never fight over the processor.

import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { Worker } from 'node:worker_threads';
import path from 'node:path';

import { phonemize } from './kokoro-phonemize.mjs';

export { splitForSpeech } from './speech-chunks.mjs';

export const KOKORO_MODEL = 'onnx-community/Kokoro-82M-v1.0-ONNX';
export const SAMPLE_RATE = 24000;
const STYLE_DIM = 256;
const STYLE_ROWS = 510;

// The English voices that ship with Kokoro v1.0. Grades are hexgrad's own,
// from the model card (A best, F worst).
export const VOICES = {
  af_heart: 'American female, grade A',
  af_bella: 'American female, grade A-',
  af_nicole: 'American female, soft, grade B-',
  af_aoede: 'American female, grade C+',
  af_kore: 'American female, grade C+',
  af_sarah: 'American female, grade C+',
  am_fenrir: 'American male, grade C+',
  am_michael: 'American male, grade C+',
  am_puck: 'American male, grade C+',
  bf_emma: 'British female, grade B-',
  bf_isabella: 'British female, grade C',
  bm_george: 'British male, grade C',
  bm_fable: 'British male, grade C',
};

export class NeuralVoice {
  constructor({
    modelId = KOKORO_MODEL,
    cacheDir,
    voicesDir,
    voice = 'af_heart',
    speed = 1,
    dtype = 'fp32',
    device = 'cpu',
    threads = 0,
    allowDownload = false,
    importTransformers = () => import('@huggingface/transformers'),
    importPhonemizer = () => import('phonemizer'),
    onLog,
  } = {}) {
    this.modelId = modelId;
    this.cacheDir = cacheDir;
    this.voicesDir = voicesDir;
    this.voice = voice;
    this.speed = speed;
    this.dtype = dtype;
    this.device = device;
    this.threads = threads;
    this.allowDownload = allowDownload;
    this.importTransformers = importTransformers;
    this.importPhonemizer = importPhonemizer;
    this.onLog = onLog;
    this.name = `kokoro ${voice} (${dtype}, ${device})`;
    this.loading = null;
    this.parts = null;
    this.styles = new Map();
    this.queue = Promise.resolve();
    this.epoch = 0;
  }

  load() {
    this.loading ??= this.#load().catch((error) => {
      this.loading = null;
      throw error;
    });
    return this.loading;
  }

  async #load() {
    const began = performance.now();
    if (!this.allowDownload) this.#checkFiles();
    const t = await this.importTransformers();
    const { phonemize: espeak } = await this.importPhonemizer();
    if (this.cacheDir) t.env.cacheDir = this.cacheDir;
    // Without this, a missing file is fetched from Hugging Face on first use.
    t.env.allowRemoteModels = Boolean(this.allowDownload);
    const sessionOptions = this.threads > 0 ? { intraOpNumThreads: this.threads, interOpNumThreads: 1 } : undefined;
    const [model, tokenizer] = await Promise.all([
      t.StyleTextToSpeech2Model.from_pretrained(this.modelId, { dtype: this.dtype, device: this.device, session_options: sessionOptions }),
      t.AutoTokenizer.from_pretrained(this.modelId),
    ]);
    this.parts = { t, model, tokenizer, espeak };
    await this.#style(this.voice);
    // One short warm-up run, so the first real sentence is not the slow one.
    await this.#run('Ready.', this.voice, this.speed);
    this.loadMs = Math.round(performance.now() - began);
    this.onLog?.(`neural voice ready: ${this.name}, ${this.loadMs} ms`);
    return this;
  }

  // A clear reason when files are missing, before the model library gives an
  // obscure one (it also remembers a failed lookup for the rest of the run).
  #checkFiles() {
    const model = path.join(this.cacheDir || '', ...this.modelId.split('/'));
    const needed = [
      path.join(model, 'config.json'),
      path.join(model, 'tokenizer.json'),
      path.join(model, 'onnx', modelFile(this.dtype)),
      path.join(this.voicesDir || '', `${this.voice}.bin`),
    ];
    const missing = needed.filter((file) => !existsSync(file));
    if (missing.length) throw new Error(`model files not found: ${missing.join(', ')}`);
  }

  async #style(voice) {
    if (!VOICES[voice] && !/^[ab][fm]_[a-z]+$/.test(voice)) throw new Error(`unknown voice "${voice}"`);
    if (this.styles.has(voice)) return this.styles.get(voice);
    const file = path.join(this.voicesDir, `${voice}.bin`);
    const bytes = await readFile(file);
    if (bytes.length !== STYLE_ROWS * STYLE_DIM * 4) throw new Error(`voice file ${file} is ${bytes.length} bytes, expected ${STYLE_ROWS * STYLE_DIM * 4}`);
    const style = new Float32Array(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.length));
    this.styles.set(voice, style);
    return style;
  }

  async #run(text, voice, speed) {
    const { t, model, tokenizer, espeak } = this.parts;
    const phonemes = await phonemize(text, espeak, voice[0]);
    const { input_ids } = tokenizer(phonemes, { truncation: true });
    const style = await this.#style(voice);
    const row = styleRow(input_ids.dims.at(-1));
    const { waveform } = await model({
      input_ids,
      style: new t.Tensor('float32', style.slice(row * STYLE_DIM, (row + 1) * STYLE_DIM), [1, STYLE_DIM]),
      speed: new t.Tensor('float32', [speed], [1]),
    });
    return waveform.data;
  }

  // Resolves to the clip, or null when stop() was called before it was ready.
  synthesize(text, { voice = this.voice, speed = this.speed } = {}) {
    const epoch = this.epoch;
    const job = this.queue.then(async () => {
      if (epoch !== this.epoch) return null;
      await this.load();
      const began = performance.now();
      const samples = trimSilence(await this.#run(text, voice, speed));
      if (epoch !== this.epoch) return null;
      return { samples, sampleRate: SAMPLE_RATE, ms: Math.round(performance.now() - began) };
    });
    this.queue = job.catch(() => {});
    return job;
  }

  // A run already inside ONNX Runtime cannot be cut short, but its result is
  // thrown away and nothing queued after it starts.
  stop() {
    this.epoch++;
  }

  async dispose() {
    this.stop();
    try {
      await this.parts?.model?.dispose?.();
    } catch {
      // Already released.
    }
    this.parts = null;
    this.loading = null;
  }
}

// Kokoro pads each clip with about 0.3 s of silence before and 0.45 s after
// (measured). Cutting the front makes the first sound come sooner; the
// player adds its own pause between pieces.
export function trimSilence(samples, { threshold = 0.01, keepLeadMs = 15, keepTailMs = 80, sampleRate = SAMPLE_RATE } = {}) {
  let start = 0;
  while (start < samples.length && Math.abs(samples[start]) < threshold) start++;
  if (start === samples.length) return samples;
  let end = samples.length - 1;
  while (end > start && Math.abs(samples[end]) < threshold) end--;
  start = Math.max(0, start - Math.round((keepLeadMs / 1000) * sampleRate));
  end = Math.min(samples.length, end + 1 + Math.round((keepTailMs / 1000) * sampleRate));
  // A copy, so only these samples cross to the window, not the whole buffer.
  return samples.slice(start, end);
}

// The file name @huggingface/transformers loads for each precision.
export function modelFile(dtype = 'fp32') {
  if (dtype === 'fp32') return 'model.onnx';
  if (dtype === 'q8') return 'model_quantized.onnx';
  return `model_${dtype}.onnx`;
}

// Kokoro has one style vector per input length; the row is picked from the
// number of tokens, without the two padding tokens.
export function styleRow(tokenCount) {
  return Math.min(Math.max(tokenCount - 2, 0), STYLE_ROWS - 1);
}

// 16-bit mono WAV, for saving clips.
export function encodeWav(samples, sampleRate = SAMPLE_RATE) {
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

// Builds the voice the config asks for and loads it. Never throws: when the
// neural voice cannot load, it says why and the caller keeps the Windows voice.
//   config.ttsEngine   "neural" (or "kokoro") or "windows" (default "windows")
//   config.ttsVoice    a Kokoro voice name, for example "af_heart"
//   config.ttsSpeed, ttsDevice ("cpu"), ttsDtype ("fp32"), ttsThreads (0 = default)
//   config.ttsModelDir folder holding the model cache and voices/; may use
//                      %NAME% for environment variables; empty means `defaultDir`
export function isNeuralEngine(engine) {
  return engine === 'neural' || engine === 'kokoro';
}

export function resolveModelDir(setting, { root = '.', defaultDir, env = process.env } = {}) {
  const raw = String(setting ?? '').trim();
  if (!raw) return defaultDir || path.resolve(root, '..', 'temp', 'voice', 'models');
  const expanded = raw.replace(/%([^%]+)%/g, (whole, name) => env[name] ?? env[name.toUpperCase()] ?? whole);
  return path.resolve(root, expanded);
}

// The same interface as NeuralVoice, with the work done on a worker thread
// (lib/neural-voice-worker.mjs) so the calling thread never stalls.
export class ThreadedVoice {
  constructor(options = {}) {
    const { onLog, ...plain } = options;
    this.options = plain;
    this.onLog = onLog;
    this.name = `kokoro ${plain.voice || 'af_heart'} (${plain.dtype || 'fp32'}, ${plain.device || 'cpu'}, own thread)`;
    this.worker = null;
    this.loading = null;
    this.jobs = new Map();
    this.nextId = 1;
    this.epoch = 0;
  }

  load() {
    this.loading ??= new Promise((resolve, reject) => {
      const worker = new Worker(new URL('./neural-voice-worker.mjs', import.meta.url));
      this.worker = worker;
      worker.unref();
      worker.on('message', (message) => {
        if (message.type === 'log') this.onLog?.(message.line.replace(/^neural voice ready: .*?\), /,`neural voice ready: ${this.name}, `));
        else if (message.type === 'loaded') resolve(this);
        else if (message.type === 'load-failed') reject(new Error(message.message));
        else if (message.type === 'clip' || message.type === 'synth-failed') {
          const job = this.jobs.get(message.id);
          this.jobs.delete(message.id);
          if (!job) return; // dropped by stop()
          if (message.type === 'clip') job.resolve(message.clip);
          else job.reject(new Error(message.message));
        }
      });
      worker.on('error', (error) => {
        reject(error);
        this.#failAll(error);
      });
      worker.on('exit', (code) => {
        if (this.worker === worker) this.worker = null;
        this.loading = null;
        const error = new Error(`the voice thread stopped (code ${code})`);
        reject(error);
        this.#failAll(error);
      });
      worker.postMessage({ type: 'load', options: this.options });
    });
    return this.loading;
  }

  #failAll(error) {
    for (const job of this.jobs.values()) job.reject(error);
    this.jobs.clear();
  }

  async synthesize(text, { voice, speed } = {}) {
    const epoch = this.epoch;
    await this.load();
    // stop() was called while this was waiting for the thread to start.
    if (epoch !== this.epoch) return null;
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.jobs.set(id, { resolve, reject });
      this.worker.postMessage({ type: 'synth', id, text, voice, speed });
    });
  }

  // Everything asked for so far resolves to null straight away; the thread
  // drops its queue and throws away the sentence it is making.
  stop() {
    this.epoch = (this.epoch ?? 0) + 1;
    for (const job of this.jobs.values()) job.resolve(null);
    this.jobs.clear();
    this.worker?.postMessage({ type: 'stop' });
  }

  async dispose() {
    this.stop();
    const worker = this.worker;
    this.worker = null;
    this.loading = null;
    if (worker) await worker.terminate();
  }
}

export async function loadNeuralVoice(config, { root, defaultDir, onLog, threaded, ...overrides } = {}) {
  if (!isNeuralEngine(config.ttsEngine || 'windows')) return { voice: null, reason: 'the Windows voice is selected' };
  const dir = resolveModelDir(config.ttsModelDir, { root, defaultDir });
  const options = {
    cacheDir: dir,
    voicesDir: path.join(dir, 'voices'),
    voice: config.ttsVoice || 'af_heart',
    speed: config.ttsSpeed || 1,
    dtype: config.ttsDtype || 'fp32',
    device: config.ttsDevice || 'cpu',
    threads: config.ttsThreads || 0,
    onLog,
    ...overrides,
  };
  // Stand-in model libraries (tests) cannot cross to another thread.
  const ownThread = threaded ?? !(overrides.importTransformers || overrides.importPhonemizer);
  const voice = ownThread ? new ThreadedVoice(options) : new NeuralVoice(options);
  try {
    await voice.load();
    return { voice, reason: null };
  } catch (error) {
    const reason = `neural voice could not load (${error.message}); using the Windows voice`;
    onLog?.(reason);
    await voice.dispose();
    return { voice: null, reason };
  }
}
