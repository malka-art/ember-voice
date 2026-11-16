// Energy-based voice activity detection. Pure logic, no browser APIs, so it
// can be tested in Node and used in the renderer.
//
// Feed it fixed-size frames of mono 16 kHz samples. It returns an event for
// each frame: null, { type: 'start' }, or { type: 'end', audio: Float32Array }.

export class VoiceDetector {
  constructor({
    sampleRate = 16000,
    silenceMs = 800,
    minSpeechMs = 300,
    preRollMs = 300,
    maxSpeechMs = 60000,
    startFrames = 3,
    floor = 0.008,
    ratio = 3.2,
  } = {}) {
    this.sampleRate = sampleRate;
    this.silenceMs = silenceMs;
    this.minSpeechMs = minSpeechMs;
    this.preRollMs = preRollMs;
    this.maxSpeechMs = maxSpeechMs;
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

    if (this.quietMs >= this.silenceMs || this.speechMs >= this.maxSpeechMs) {
      const voiced = this.voicedMs;
      const audio = concat(this.chunks);
      this.reset();
      if (voiced < this.minSpeechMs) return { type: 'discard' };
      return { type: 'end', audio };
    }
    return null;
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
