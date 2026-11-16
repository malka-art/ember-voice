import { VoiceDetector } from '../lib/vad.mjs';

// While you talk, the sentence so far is handed over for a quick look: soon
// after you start (to catch the bar's name early), then about once a second.
const FIRST_PARTIAL_MS = 900;
const PARTIAL_EVERY_MS = 1000;
const LAST_PARTIAL_MS = 30000;

// Opens the microphone and reports when someone starts and stops talking.
export class Listener {
  constructor({ silenceMs, onStart, onEnd, onDiscard, onLevel, onLost, onPartial }) {
    this.detector = new VoiceDetector({ silenceMs });
    this.handlers = { onStart, onEnd, onDiscard, onLevel, onLost, onPartial };
    this.nextPartialMs = FIRST_PARTIAL_MS;
    this.open = false; // whether speech should be picked up right now
    this.context = null;
    this.stream = null;
    this.deviceLabel = '';
  }

  get running() {
    return Boolean(this.stream);
  }

  // Whether the open microphone is no longer the one to use: its sound has
  // stopped without saying so, or Windows' default microphone is now another
  // device (a headset came back and became the default again).
  async stale() {
    const track = this.stream?.getAudioTracks()[0];
    if (!track) return false;
    if (track.readyState === 'ended') return true;
    const settings = track.getSettings?.() ?? {};
    // Opened without naming a device, so it should be on the default one.
    if (settings.deviceId && settings.deviceId !== 'default') return false;
    const devices = await navigator.mediaDevices.enumerateDevices();
    const now = devices.find((device) => device.kind === 'audioinput' && device.deviceId === 'default');
    if (!now) return false;
    if (now.groupId && settings.groupId) return now.groupId !== settings.groupId;
    return Boolean(now.label && track.label) && now.label !== track.label;
  }

  async start() {
    this.stop();
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });
    const context = new AudioContext({ sampleRate: 16000 });
    try {
      await context.audioWorklet.addModule('capture-worklet.js');
    } catch (error) {
      stream.getTracks().forEach((track) => track.stop());
      context.close();
      throw error;
    }
    const source = context.createMediaStreamSource(stream);
    const capture = new AudioWorkletNode(context, 'capture');
    capture.port.onmessage = (event) => this.#onFrame(event.data);
    source.connect(capture);

    const [track] = stream.getAudioTracks();
    this.deviceLabel = track?.label ?? '';
    // The microphone was unplugged, or a headset switched off.
    track?.addEventListener('ended', () => {
      if (this.stream !== stream) return;
      this.stop();
      this.handlers.onLost?.();
    });

    this.stream = stream;
    this.context = context;
    this.detector.reset();
  }

  // Lets go of the microphone completely, so a wireless headset can go back
  // to full-quality sound while the widget is not listening.
  stop() {
    this.stream?.getTracks().forEach((track) => track.stop());
    this.context?.close();
    this.stream = null;
    this.context = null;
    this.detector.reset();
    this.handlers.onLevel?.(0);
  }

  setOpen(open) {
    if (this.open === open) return;
    this.open = open;
    if (!open) {
      this.detector.reset();
      this.handlers.onLevel?.(0);
    }
  }

  #onFrame(frame) {
    if (!this.open) return;
    const event = this.detector.push(frame);
    // Scale the level so normal speech fills most of the range.
    this.handlers.onLevel?.(Math.min(1, this.detector.level * 9));
    if (!event) {
      const heard = this.detector.speechMs;
      if (this.detector.speaking && heard >= this.nextPartialMs && heard <= LAST_PARTIAL_MS) {
        this.nextPartialMs = heard + PARTIAL_EVERY_MS;
        this.handlers.onPartial?.(this.detector.peek());
      }
      return;
    }
    if (event.type === 'start') {
      this.nextPartialMs = FIRST_PARTIAL_MS;
      this.handlers.onStart?.();
    }
    else if (event.type === 'end') this.handlers.onEnd?.(event.audio);
    else if (event.type === 'discard') this.handlers.onDiscard?.();
  }
}
