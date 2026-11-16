// Runs the neural voice on its own thread. ONNX Runtime's run() holds the
// thread it is called on for most of its time (measured: 0.9 s of a 1.0 s
// sentence), so on the main process's thread it would freeze the bar's
// messages, logging and speech-to-text hand-off while the voice is being made.
//
// Messages in:  { type: 'load', options } | { type: 'synth', id, text, voice, speed }
//               | { type: 'stop' } | { type: 'dispose' }
// Messages out: { type: 'loaded' } | { type: 'load-failed', message }
//               | { type: 'clip', id, clip } | { type: 'synth-failed', id, message }
//               | { type: 'log', line }

import { parentPort } from 'node:worker_threads';

import { NeuralVoice } from './neural-voice.mjs';

let voice = null;

parentPort.on('message', async (message) => {
  switch (message.type) {
    case 'load':
      try {
        voice = new NeuralVoice({ ...message.options, onLog: (line) => parentPort.postMessage({ type: 'log', line }) });
        await voice.load();
        parentPort.postMessage({ type: 'loaded', loadMs: voice.loadMs });
      } catch (error) {
        parentPort.postMessage({ type: 'load-failed', message: error.message });
      }
      return;
    case 'synth':
      try {
        const clip = await voice.synthesize(message.text, { voice: message.voice, speed: message.speed });
        // The samples are handed over, not copied.
        parentPort.postMessage({ type: 'clip', id: message.id, clip }, clip ? [clip.samples.buffer] : []);
      } catch (error) {
        parentPort.postMessage({ type: 'synth-failed', id: message.id, message: error.message });
      }
      return;
    case 'stop':
      voice?.stop();
      return;
    case 'dispose':
      await voice?.dispose();
      parentPort.close();
      return;
    default:
      return;
  }
});
