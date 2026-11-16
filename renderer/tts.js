import { SentenceStream } from '../lib/speech-text.mjs';

// Reads the reply aloud sentence by sentence while it is still arriving,
// using the voices built into the operating system.
export class Speaker {
  constructor({ voiceName, rate, onChange, onLog }) {
    this.voiceName = voiceName;
    this.rate = rate || 1;
    this.onChange = onChange;
    this.onLog = onLog;
    this.enabled = true;
    this.sentences = new SentenceStream();
    this.outstanding = 0;
    this.voice = null;
    this.#pickVoice();
    speechSynthesis.addEventListener?.('voiceschanged', () => this.#pickVoice());
  }

  get speaking() {
    return this.outstanding > 0;
  }

  #pickVoice() {
    const voices = speechSynthesis.getVoices();
    if (!voices.length) return;
    const wanted = this.voiceName?.toLowerCase();
    const before = this.voice?.name;
    this.voice =
      (wanted && voices.find((v) => v.name.toLowerCase().includes(wanted))) ||
      voices.find((v) => v.lang?.startsWith('en') && /natural|online/i.test(v.name)) ||
      voices.find((v) => v.lang?.startsWith('en') && v.default) ||
      voices.find((v) => v.lang?.startsWith('en')) ||
      voices[0];
    if (this.voice.name !== before) {
      this.onLog?.(`voice: ${this.voice.name} (of ${voices.length}: ${voices.map((v) => v.name).join('; ')})`);
    }
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
    const utterance = new SpeechSynthesisUtterance(text);
    if (this.voice) utterance.voice = this.voice;
    utterance.rate = this.rate;
    const done = () => {
      if (utterance.counted) return;
      utterance.counted = true;
      this.outstanding = Math.max(0, this.outstanding - 1);
      this.onChange?.();
    };
    const began = performance.now();
    utterance.onend = () => {
      this.onLog?.(`spoke ${text.length} characters in ${Math.round(performance.now() - began)} ms`);
      done();
    };
    utterance.onerror = (event) => {
      // Cutting a reply short reports itself as an error; that one is expected.
      if (event.error !== 'interrupted' && event.error !== 'canceled') this.onLog?.(`voice error: ${event.error}`);
      done();
    };
    this.outstanding++;
    speechSynthesis.speak(utterance);
    this.onChange?.();
  }

  cancel() {
    this.sentences.reset();
    this.outstanding = 0;
    speechSynthesis.cancel();
    this.onChange?.();
  }

  setEnabled(enabled) {
    this.enabled = enabled;
    if (!enabled) this.cancel();
  }
}
