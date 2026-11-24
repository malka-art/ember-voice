// Real-time listening fixes from the November review (each test is named
// after the problem it guards against).
import assert from 'node:assert/strict';
import test from 'node:test';

import { VoiceDetector } from '../lib/vad.mjs';

const frame = (amp) => Float32Array.from({ length: 512 }, (_, i) => amp * Math.sin(i / 3));
const feed = (vad, amp, ms) => {
  const events = [];
  for (let t = 0; t < ms; t += 32) {
    const e = vad.push(frame(amp));
    if (e) events.push(e);
  }
  return events;
};

test('regr_trailing_silence: the pause that ends a sentence is not sent with it', () => {
  const vad = new VoiceDetector({ silenceMs: 1500 });
  feed(vad, 0.001, 1000);
  feed(vad, 0.2, 2000);
  const [end] = feed(vad, 0.001, 1600);
  assert.equal(end.type, 'end');
  const seconds = end.audio.length / 16000;
  // Before: 0.3 pre-roll + 2.0 speech + 1.5 quiet = 3.8 s. Now about 2.6 s.
  assert.ok(seconds < 2.8, `utterance was ${seconds}s`);
  // The quiet kept at the end is short, and the speech itself is all there.
  let loud = 0;
  for (const s of end.audio) if (Math.abs(s) > 0.05) loud++;
  assert.ok(loud / 16000 > 1.2, 'speech kept');
});

test('regr_long_dictation_cut: after 40 s a short breath ends the sentence, between words', () => {
  const vad = new VoiceDetector({ silenceMs: 1500 });
  feed(vad, 0.001, 500);
  const events = [];
  // 50 s of talking with a 0.5 s breath every 5 s.
  for (let i = 0; i < 10; i++) events.push(...feed(vad, 0.2, 4500), ...feed(vad, 0.001, 500));
  const ends = events.filter((e) => e.type === 'end');
  assert.ok(ends.length >= 1, 'a breath after 40 s ended it');
  assert.equal(ends[0].cut, undefined, 'ended at a pause, not at the hard limit');
  const seconds = ends[0].audio.length / 16000;
  assert.ok(seconds >= 40 && seconds < 46, `first part was ${seconds}s`);
});

test('regr_long_dictation_cut: at the hard limit nothing is lost, the next part starts at once', () => {
  const vad = new VoiceDetector({ silenceMs: 1500, maxSpeechMs: 10000, softMaxMs: 8000 });
  feed(vad, 0.001, 500);
  // 14 s of talking without a single pause.
  const events = feed(vad, 0.2, 14000);
  const ends = events.filter((e) => e.type === 'end');
  assert.equal(ends.length, 1);
  assert.equal(ends[0].cut, true);
  assert.equal(vad.speaking, true, 'still hearing the rest');
  const [rest] = feed(vad, 0.001, 1600);
  assert.equal(rest.type, 'end');
  const total = (ends[0].audio.length + rest.audio.length) / 16000;
  // Every frame of the 14 s is in one part or the other.
  assert.ok(total >= 14, `parts add up to ${total}s`);
});
