// Energy-based voice activity detection. Pure logic, no browser APIs, so it
// can be tested in Node and used in the renderer.
//
// Feed it fixed-size frames of mono 16 kHz samples. It returns an event for
// each frame: null, { type: 'start' }, or { type: 'end', audio: Float32Array }.
//
// Long dictation: past `softMaxMs` a short breath (`softSilenceMs`) ends the
// sentence, so it is cut between words, not mid-word at the hard limit. If
// the hard limit is reached anyway, the end carries `cut: true` and the next
// sentence starts at once from the very next frame, so no word is lost.
//
// The silence that ended a sentence is not sent with it: only `tailMs` of it
// is kept. Whisper does nothing useful with 1.5 s of quiet except, now and
// then, invent words for it, and it is time spent before the text is ready.

export class VoiceDetector {
  constructor({
    sampleRate = 16000,
    silenceMs = 800,
    minSpeechMs = 300,
    preRollMs = 300,
    maxSpeechMs = 60000,
    softMaxMs = 40000,
    softSilenceMs = 400,
    tailMs = 300,
    startFrames = 3,
    floor = 0.008,
    ratio = 3.2,
  } = {}) {
    this.sampleRate = sampleRate;
    this.silenceMs = silenceMs;
    this.minSpeechMs = minSpeechMs;
    this.preRollMs = preRollMs;
    this.maxSpeechMs = maxSpeechMs;
    this.softMaxMs = softMaxMs;
    this.softSilenceMs = Math.min(softSilenceMs, silenceMs);
    this.tailMs = tailMs;
    this.startFrames = startFrames;
    this.floor = floor;
    this.ratio = ratio;
    this.noise = floor / 2;
    this.level = 0;
    this.reset();
  }

  reset() {
    this.speaking = false;
    this.loudRun = 0;
    this.quietMs = 0;
    this.speechMs = 0;
    this.voicedMs = 0;
    this.chunks = [];
    this.preRoll = [];
    this.preRollLen = 0;
  }

  // The audio of the sentence so far while one is being heard, else null.
  peek() {
    return this.speaking ? concat(this.chunks) : null;
  }

  static rms(frame) {
    let sum = 0;
    for (let i = 0; i < frame.length; i++) sum += frame[i] * frame[i];
    return Math.sqrt(sum / frame.length);
  }

  threshold() {
    return Math.max(this.floor, this.noise * this.ratio);
  }

  push(frame) {
    const rms = VoiceDetector.rms(frame);
    const frameMs = (frame.length / this.sampleRate) * 1000;
    this.level = rms;
    const loud = rms > this.threshold();

    if (!this.speaking) {
      // Track the room's background level only while nobody is talking.
      if (!loud) this.noise = this.noise * 0.95 + rms * 0.05;

      this.preRoll.push(frame);
      this.preRollLen += frameMs;
      while (this.preRollLen - (this.preRoll[0].length / this.sampleRate) * 1000 >= this.preRollMs) {
        this.preRollLen -= (this.preRoll.shift().length / this.sampleRate) * 1000;
      }

      this.loudRun = loud ? this.loudRun + 1 : 0;
      if (this.loudRun >= this.startFrames) {
        this.speaking = true;
        this.chunks = this.preRoll;
        this.speechMs = this.preRollLen;
        this.voicedMs = this.loudRun * frameMs;
        this.quietMs = 0;
        this.preRoll = [];
        this.preRollLen = 0;
        this.loudRun = 0;
        return { type: 'start' };
      }
      return null;
    }

    this.chunks.push(frame);
    this.speechMs += frameMs;
    if (loud) {
      this.voicedMs += frameMs;
      this.quietMs = 0;
    } else {
      this.quietMs += frameMs;
    }

    const pauseEnds = this.quietMs >= this.silenceMs || (this.speechMs >= this.softMaxMs && this.quietMs >= this.softSilenceMs);
    const atLimit = !pauseEnds && this.speechMs >= this.maxSpeechMs;
    if (pauseEnds || atLimit) {
      const voiced = this.voicedMs;
      // Keep only the first `tailMs` of the closing quiet.
      const quietFrames = Math.floor(this.quietMs / frameMs);
      const keepFrames = Math.ceil(this.tailMs / frameMs);
      const drop = Math.max(0, Math.min(quietFrames - keepFrames, this.chunks.length - 1));
      const audio = concat(drop ? this.chunks.slice(0, this.chunks.length - drop) : this.chunks);
      this.reset();
      // Still talking at the hard limit: the next sentence is already under way.
      if (atLimit) this.#resume();
      if (voiced < this.minSpeechMs) return { type: 'discard' };
      return atLimit ? { type: 'end', audio, cut: true } : { type: 'end', audio };
    }
    return null;
  }

  #resume() {
    this.speaking = true;
    this.chunks = [];
    this.speechMs = 0;
    // Counts as voiced already: it is the same person mid-sentence.
    this.voicedMs = this.minSpeechMs;
    this.quietMs = 0;
  }
}

export function concat(chunks) {
  let total = 0;
  for (const c of chunks) total += c.length;
  const out = new Float32Array(total);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.length;
  }
  return out;
}
