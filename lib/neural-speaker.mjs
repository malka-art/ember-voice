// Plays the neural voice in the window, with the same interface as the
// Windows-voice Speaker in renderer/tts.js (feed, finish, say, cancel,
// setEnabled, speaking, enabled), so the window can use either one.
//
// The audio is made in the main process (lib/neural-voice.mjs) and handed
// over as samples; this file only schedules and plays it. Browser code: it
// uses Web Audio and must not import anything from Node.
//
// If the neural voice fails at any point, everything after that is spoken by
// the fallback Speaker, and one line says so in the log.

import { splitForSpeech } from './speech-chunks.mjs';
import { SentenceStream } from './speech-text.mjs';

// Pauses after a piece: longer at the end of a sentence than at a comma.
const SENTENCE_GAP_S = 0.28;
const CLAUSE_GAP_S = 0.1;
// Each sentence is voiced whole, so the voice gives it one natural rise and
// fall. (Short first pieces cut mid-phrase started sooner but gave every
// fragment its own falling tone.) Only a very long sentence is split, and
// then at its commas and semicolons.
const MAX_PIECE_CHARS = 280;
const SENTENCE_END = /(?<=[.!?…]["')\]]*)\s+(?=["'(\[]?[A-Z0-9])/;

// Pieces for `text`: its sentences, each whole unless very long. The second
// argument is kept for callers that pass how much is queued ahead.
export function piecesFor(text, _aheadChars = 0) {
  const clean = String(text ?? '').replace(/\s+/g, ' ').trim();
  if (!clean) return [];
  return clean
    .split(SENTENCE_END)
    .map((sentence) => sentence.trim())
    .filter(Boolean)
    .flatMap((sentence) => splitForSpeech(sentence, { maxChars: MAX_PIECE_CHARS }));
}
export class NeuralSpeaker {
  // synth(text) resolves to { samples: Float32Array, sampleRate } or null;
  // stopSynth() drops whatever the main process still has queued.
  constructor({ synth, stopSynth, fallback, onChange, onLog, audioContext, volume = 1 }) {
    this.synth = synth;
    this.stopSynth = stopSynth;
    this.fallback = fallback;
    this.onChange = onChange;
    this.onLog = onLog;
    this.ctx = audioContext || null;
    this.volume = volume;
    this.enabled = true;
    this.failed = false;
    this.sentences = new SentenceStream();
    this.epoch = 0;
    this.pending = 0; // pieces asked for and not yet finished playing
    this.aheadChars = 0; // their length in characters
    this.sources = new Set();
    this.playhead = 0;
    this.chain = Promise.resolve(); // keeps pieces in order
  }

  get speaking() {
    return this.pending > 0 || Boolean(this.fallback?.speaking);
  }

  feed(delta) {
    for (const sentence of this.sentences.feed(delta)) this.#say(sentence);
  }

  finish() {
    for (const sentence of this.sentences.flush()) this.#say(sentence);
  }

  say(text) {
    this.#say(text);
  }

  #say(text) {
    if (!this.enabled || !text) return;
    if (this.failed) {
      this.fallback?.say(text);
      return;
    }
    for (const piece of piecesFor(text, this.aheadChars)) this.#queue(piece);
  }

  #queue(text) {
    const epoch = this.epoch;
    const asked = performance.now();
    // Ask for every piece at once (the main process makes them one at a
    // time, in order), but play them strictly in order.
    const made = Promise.resolve()
      .then(() => this.synth(text))
      .then(
        (clip) => ({ clip }),
        (error) => ({ error }),
      );
    this.pending++;
    this.aheadChars += text.length;
    this.onChange?.();
    this.chain = this.chain.then(async () => {
      const { clip, error } = await made;
      if (epoch !== this.epoch) return;
      if (error || !clip) {
        this.#done(text);
        if (error) this.#fail(error, text);
        return;
      }
      this.#play(clip, epoch, asked, text);
    });
  }

  #fail(error, text) {
    if (!this.failed) {
      this.failed = true;
      this.onLog?.(`neural voice failed (${error?.message || error}); switching to the Windows voice`);
    }
    // Pieces already asked for when it failed are spoken by the fallback too.
    this.fallback?.say(text);
  }

  #play(clip, epoch, asked, text) {
    this.ctx ??= new AudioContext();
    const ctx = this.ctx;
    if (ctx.state === 'suspended') ctx.resume();
    const samples = clip.samples instanceof Float32Array ? clip.samples : new Float32Array(clip.samples);
    const buffer = ctx.createBuffer(1, samples.length, clip.sampleRate);
    buffer.copyToChannel(samples, 0);
    const source = ctx.createBufferSource();
    source.buffer = buffer;
    const gain = ctx.createGain();
    gain.gain.value = this.volume;
    source.connect(gain).connect(this.#output(ctx));
    const at = Math.max(ctx.currentTime + 0.01, this.playhead);
    this.playhead = at + buffer.duration + (/[.!?]['")\]]*$/.test(text) ? SENTENCE_GAP_S : CLAUSE_GAP_S);
    this.sources.add(source);
    source.start(at);
    const startsIn = Math.max(0, (at - ctx.currentTime) * 1000);
    this.lastStart = { text, waitedMs: Math.round(performance.now() - asked + startsIn) };
    this.onLog?.(`neural voice: ${text.length} characters, made in ${clip.ms ?? '?'} ms, sound after ${this.lastStart.waitedMs} ms`);
    // The next piece is scheduled without waiting for this one to end; the
    // playhead keeps them back to back.
    source.onended = () => {
      this.sources.delete(source);
      if (epoch !== this.epoch) return;
      // Same line as the Windows voice writes: main.mjs keeps the no-name
      // listening window open from it.
      this.onLog?.(`spoke ${text.length} characters in ${Math.round(performance.now() - asked)} ms`);
      this.#done(text);
    };
  }

  // Everything played goes through one analyser on its way out, so the orb
  // can follow the real loudness of the voice.
  #output(ctx) {
    if (!ctx.createAnalyser) return ctx.destination;
    if (!this.analyser) {
      this.analyser = ctx.createAnalyser();
      this.analyser.fftSize = 512;
      this.analyser.connect(ctx.destination);
      this.levelFrame = new Float32Array(this.analyser.fftSize);
    }
    return this.analyser;
  }

  // How loud the voice is right now, 0 to 1 (null when it cannot be measured,
  // for example while the Windows voice is speaking instead).
  outputLevel() {
    if (this.failed || !this.analyser) return this.sources.size ? null : 0;
    this.analyser.getFloatTimeDomainData(this.levelFrame);
    let sum = 0;
    for (const v of this.levelFrame) sum += v * v;
    return Math.min(1, Math.sqrt(sum / this.levelFrame.length) * 5);
  }

  #done(text) {
    this.pending = Math.max(0, this.pending - 1);
    this.aheadChars = Math.max(0, this.aheadChars - text.length);
    this.onChange?.();
  }

  // Cuts the voice at once: playing audio stops, queued pieces are dropped.
  cancel() {
    this.epoch++;
    this.sentences.reset();
    for (const source of this.sources) {
      try {
        source.onended = null;
        source.stop();
      } catch {
        // Already stopped.
      }
    }
    this.sources.clear();
    this.pending = 0;
    this.aheadChars = 0;
    this.playhead = 0;
    this.chain = Promise.resolve();
    try {
      this.stopSynth?.();
    } catch {
      // The main process may already be gone.
    }
    this.fallback?.cancel();
    this.onChange?.();
  }

  setEnabled(enabled) {
    this.enabled = enabled;
    this.fallback?.setEnabled(enabled);
    if (!enabled) this.cancel();
  }
}
