import { Listener } from './audio.js';
import { Orb } from './orb.js';
import { NeuralSpeaker } from '../lib/neural-speaker.mjs';
import { cleanForSpeech } from '../lib/speech-text.mjs';
import { Speaker } from './tts.js';

const $ = (id) => document.getElementById(id);
const el = {
  stack: $('stack'),
  bar: $('bar'),
  orb: $('orb'),
  note: $('note'),
  noteText: $('note-text'),
  close: $('close'),
  session: $('session'),
  typed: $('typed'),
  readout: $('readout'),
  mic: $('mic'),
  voice: $('voice'),
  approvals: $('approvals'),
  badge: $('badge'),
  gear: $('gear'),
  settings: $('settings'),
  setVoices: $('set-voices'),
  setSpeed: $('set-speed'),
  setSpeedValue: $('set-speed-value'),
  setFollow: $('set-follow'),
  setWake: $('set-wake'),
  setTheme: $('set-theme'),
  heard: $('heard'),
  heardText: $('heard-text'),
  approval: $('approval'),
  approvalTitle: $('approval-title'),
  approvalDetail: $('approval-detail'),
  approvalAllow: $('approval-allow'),
  approvalDeny: $('approval-deny'),
};

const api = window.ember;
const orb = new Orb($('orb-canvas'));

// Everything the display is derived from.
const view = {
  connected: false,
  signedOut: false, // Claude Code has no sign-in on this computer
  title: '', // the session's name, shown under the status
  micOn: true,
  micWorks: false,
  hearing: false, // the user is mid-sentence
  transcribing: false,
  turnActive: false, // Claude is working on a reply
  activity: 'Thinking',
  error: '',
  notice: '',
  setup: '', // e.g. speech model download progress
  offline: '', // thread mode: why nothing is listening
  mock: false,
  // Awake: listening without its name. Asleep: waiting for "Ember". While
  // asleep, sound is still transcribed to catch the name, but nothing shows.
  awake: true,
  // Thread mode: you can speak while Claude works, and it reaches the turn.
  midTurn: false,
};
// A reply that arrived while you were mid-sentence, spoken once you stop.
let heldReply = null;
// The sentence being heard began while the widget was talking.
let startedOverSpeech = false;
// The sentence being heard began while awake, or its name was heard in it.
let sentenceAwake = false;
const approvals = []; // { id, label, detail }
let heardTimer = null;
let noticeTimer = null;
let speaker = null;
let windowsVoice = null;
let listener = null;
let micLevel = 0; // 0 to 1, from the microphone
let settings = null; // the settings panel's current choices
const demo = { on: false, speaking: false, level: 0, outLevel: 0 }; // screenshot runs only

function currentState() {
  if (view.error) return 'error';
  if (view.signedOut) return 'signedout';
  // A sentence begun while awake still counts if the no-name window closes
  // before you finish it, so the glow stays on until you stop.
  const awake = view.awake || ((view.hearing || view.transcribing) && sentenceAwake);
  if (speaker?.speaking || demo.speaking) return 'speaking';
  if (view.turnActive) return awake && view.hearing ? 'listening' : 'thinking';
  if (awake && view.transcribing) return 'transcribing';
  if (awake && view.hearing) return 'listening';
  if (!view.connected) return 'starting';
  if (!view.micOn || !view.micWorks) return 'muted';
  return 'idle';
}

// The bar shows no status words: the orb and its glow carry the state. Words
// appear in a small note above the bar only when something needs you, and the
// note goes away once it is sorted.
function problemText(state) {
  if (view.notice) return view.notice;
  switch (state) {
    case 'error':
      return view.error;
    case 'signedout':
      return 'Claude Code is signed out. Run "claude auth login" in a terminal, then click the orb.';
    case 'starting':
      return view.offline || view.setup || '';
    case 'muted':
      if (view.setup) return view.setup;
      // A muted mic shows on its own button; only a missing one needs words.
      return view.micOn ? 'Connect your microphone' : '';
    default:
      return view.setup || '';
  }
}

function render() {
  const state = currentState();
  el.bar.dataset.state = state;
  el.bar.dataset.wake = view.awake ? 'awake' : 'asleep';
  const problem = problemText(state);
  el.noteText.textContent = problem;
  el.note.hidden = !problem;
  el.note.dataset.kind = state === 'error' || state === 'signedout' ? 'error' : 'info';
  el.session.textContent = view.title;
  el.session.title = view.title;
  orb.set(state === 'signedout' ? 'error' : state);

  // Thread mode listens all the time: while Claude works, so you can add to
  // or correct the request mid-turn, and while the widget speaks, so you can
  // cut it off (its own voice coming back is caught in the main process).
  // Other modes stay half-duplex: only your turn.
  const myTurn =
    view.connected &&
    view.micOn &&
    (view.midTurn || (!view.turnActive && !speaker?.speaking)) &&
    !view.transcribing &&
    !view.error;
  listener?.setOpen(myTurn);

  const interruptible = state === 'speaking' || state === 'thinking';
  const orbAction = state === 'signedout' ? 'Reconnect' : interruptible ? 'Stop the reply' : '';
  el.orb.setAttribute('aria-label', orbAction || 'Ember');
  el.orb.title = orbAction;
}

// The ring's bloom: follows the microphone while you are heard (awake only),
// and the voice's real output while it speaks. Runs every frame.
let bloom = 0;
function animateBloom(now) {
  const state = el.bar.dataset.state;
  let target = 0;
  if (state === 'listening') {
    target = 0.35 + 0.65 * (demo.on ? demo.level : micLevel);
  } else if (state === 'speaking') {
    let out = demo.on ? demo.outLevel : speaker?.outputLevel?.();
    // The Windows voice cannot be measured: a gentle pulse instead.
    if (out === null || out === undefined) out = 0.35 + 0.25 * Math.sin(now / 320);
    target = 0.3 + 0.7 * out;
  }
  bloom += (target - bloom) * (target > bloom ? 0.35 : 0.12);
  if (bloom < 0.002) bloom = 0;
  document.documentElement.style.setProperty('--bloom', bloom.toFixed(3));
  requestAnimationFrame(animateBloom);
}

// The card above the bar shows what you said, as the bar understood it, so
// you can check it. It fades as soon as the words reach the thread; replies
// are read in the thread itself.
// While you talk it shows the words so far (`live`, dimmer); once you stop,
// the whole sentence as sent. The final words stay up at least HEARD_MIN_MS
// so they can be read, even when the thread takes them at once.
const HEARD_FADE_MS = 400;
const HEARD_MIN_MS = 1800;
const HEARD_LONGEST_MS = 20000; // if the thread never confirms
let heardShownAt = 0;
function showHeard(text, { live = false } = {}) {
  clearTimeout(heardTimer);
  if (!text) return;
  el.heard.classList.remove('fading');
  el.heard.classList.toggle('live', live);
  el.heardText.textContent = text;
  el.heardText.scrollTop = el.heardText.scrollHeight;
  el.heard.hidden = false;
  if (!live) heardShownAt = performance.now();
  heardTimer = setTimeout(fadeHeard, HEARD_LONGEST_MS);
}

function fadeHeard() {
  clearTimeout(heardTimer);
  if (el.heard.hidden) return;
  const shownFor = performance.now() - heardShownAt;
  if (!el.heard.classList.contains('live') && shownFor < HEARD_MIN_MS) {
    heardTimer = setTimeout(fadeHeard, HEARD_MIN_MS - shownFor);
    return;
  }
  el.heard.classList.add('fading');
  heardTimer = setTimeout(() => {
    el.heard.hidden = true;
    el.heard.classList.remove('fading');
  }, HEARD_FADE_MS);
}

function hideHeard() {
  clearTimeout(heardTimer);
  el.heard.hidden = true;
  el.heard.classList.remove('fading');
}

function showNotice(message, ms = 2500) {
  view.notice = message;
  clearTimeout(noticeTimer);
  noticeTimer = setTimeout(() => {
    view.notice = '';
    render();
  }, ms);
  render();
}

function showError(message) {
  view.error = message;
  view.turnActive = false;
  view.transcribing = false;
  speaker?.cancel();
  render();
  setTimeout(() => {
    if (view.error === message) {
      view.error = '';
      render();
    }
  }, 9000);
}

function renderApprovals() {
  const next = approvals[0];
  el.badge.hidden = approvals.length === 0;
  el.badge.textContent = String(approvals.length);
  const label = approvals.length
    ? `${approvals.length} waiting for approval`
    : 'Nothing is waiting for approval';
  el.approvals.setAttribute('aria-label', label);
  el.approvals.title = label;
  if (!next) {
    el.approval.hidden = true;
  } else {
    el.approvalTitle.textContent = `Allow this? ${next.label}`;
    el.approvalDetail.textContent = next.detail;
    el.approval.hidden = false;
  }
  render();
}

function answerApproval(allow) {
  const next = approvals[0];
  if (next) api.permission(next.id, allow);
}

function beginTurn() {
  view.turnActive = true;
  view.activity = 'Thinking';
  view.error = '';
}

function openTyping() {
  el.session.hidden = true;
  el.typed.hidden = false;
  el.typed.focus();
}

function releaseHeldReply() {
  if (heldReply === null) return;
  const text = heldReply;
  heldReply = null;
  speaker.feed(text);
  speaker.finish();
}

function stopReply() {
  heldReply = null;
  speaker?.cancel();
  if (view.turnActive) api.interrupt();
  render();
}

function handle(event) {
  switch (event.type) {
    case 'attached':
      view.offline = '';
      view.connected = false;
      view.signedOut = false;
      view.turnActive = false;
      view.mock = event.mock;
      view.title = event.title;
      speaker?.cancel();
      hideHeard();
      break;
    case 'ready':
      view.offline = '';
      view.connected = true;
      view.signedOut = false;
      break;
    case 'signed-out':
      view.signedOut = true;
      view.connected = false;
      view.turnActive = false;
      view.transcribing = false;
      speaker?.cancel();
      hideHeard();
      break;
    case 'stt-progress':
      view.setup = `Downloading the speech model, ${event.percent}%`;
      break;
    case 'stt-ready':
      view.setup = '';
      break;
    case 'heard':
      view.transcribing = false;
      // You were taken as meaning it (your name for it, or inside the window):
      // whatever the widget was still saying gives way.
      heldReply = null;
      speaker?.cancel();
      showHeard(event.text);
      beginTurn();
      break;
    case 'delivered':
      // Thread mode: your words are in the thread now.
      fadeHeard();
      break;
    case 'progress':
      // Claude wrote something while still working: say it now.
      if (view.hearing) heldReply = heldReply ? `${heldReply} ${event.text}` : event.text;
      // Read as words only: bold marks, bullets and the like are dropped.
      else speaker.say(cleanForSpeech(event.text));
      break;
    case 'heard-nothing':
      view.transcribing = false;
      // Words shown while you talked turned out not to be for the bar.
      if (el.heard.classList.contains('live')) hideHeard();
      break;
    case 'for-another':
      // You named another bar: this one stops glowing and listening at once
      // (it stays asleep until its own name), and shows none of your words.
      view.awake = false;
      sentenceAwake = false;
      if (!view.hearing) view.transcribing = false;
      if (el.heard.classList.contains('live')) hideHeard();
      break;
    case 'partial':
      // The sentence so far, while you are still talking (or just finishing).
      if (!view.hearing && !view.transcribing) break;
      if (event.called) {
        // Its name: glow now, and stop talking if it was.
        view.awake = true;
        sentenceAwake = true;
        heldReply = null;
        speaker?.cancel();
      }
      showHeard(event.text, { live: true });
      break;
    case 'wake':
      if (demo.on) return;
      view.awake = event.awake;
      break;
    case 'thinking':
      view.activity = 'Thinking';
      // Its own session (not thread mode) has the words once it thinks.
      if (!view.midTurn) fadeHeard();
      break;
    case 'turn-started':
      // Thread mode: a turn began in the thread, spoken here or typed there.
      if (!view.turnActive) beginTurn();
      break;
    case 'offline':
      // Thread mode: no live thread is on the other end.
      view.connected = false;
      view.offline = event.status;
      showError(event.message);
      if (event.spoken) speaker?.say(event.spoken);
      return;
    case 'tool':
      view.activity = event.label;
      break;
    case 'delta':
      speaker.feed(event.text);
      break;
    case 'done':
      view.turnActive = false;
      if (!event.streamed && event.text) {
        // Already spoken piece by piece while Claude worked: not repeated.
        // Otherwise, speaking now would talk over you mid-sentence, so the
        // reply waits until you stop.
        if (event.spoken) {
          // Nothing more to say.
        } else if (view.hearing) heldReply = event.text;
        else speaker.feed(event.text);
      }
      if (heldReply === null) speaker.finish();
      if (event.isError && event.text) showError(event.text);
      break;
    case 'permission':
      approvals.push({ id: event.id, label: event.label, detail: event.detail });
      if (approvals.length === 1) speaker.say(`I need your OK. ${event.label}.`);
      renderApprovals();
      return;
    case 'permission-cleared': {
      const index = approvals.findIndex((item) => item.id === event.id);
      if (index !== -1) approvals.splice(index, 1);
      renderApprovals();
      return;
    }
    case 'notice':
      showNotice(event.message);
      return;
    case 'title':
      // The thread was renamed in the app.
      view.title = event.title;
      break;
    case 'type-request':
      openTyping();
      return;
    case 'pc-awake':
      // The PC woke from sleep or was unlocked.
      reopenMic();
      return;
    case 'closed':
      view.connected = false;
      view.turnActive = false;
      showError('The session closed. Right-click the bar to pick another.');
      return;
    case 'error':
      showError(event.message);
      return;
    default:
      return;
  }
  render();
}

function wireControls() {
  el.orb.addEventListener('click', () => {
    if (view.signedOut) api.reconnect();
    else stopReply();
  });

  el.mic.addEventListener('click', () => {
    view.micOn = !view.micOn;
    el.mic.setAttribute('aria-pressed', String(view.micOn));
    const label = view.micOn ? 'Mute the microphone' : 'Turn the microphone on';
    el.mic.setAttribute('aria-label', label);
    el.mic.title = label;
    view.hearing = false;
    releaseHeldReply();
    // Muting lets go of the microphone itself, not just the listening.
    if (view.micOn) openMic();
    else listener?.stop();
    render();
  });

  el.voice.addEventListener('click', () => {
    const on = !speaker.enabled;
    speaker.setEnabled(on);
    el.voice.setAttribute('aria-pressed', String(on));
    const label = on ? 'Turn the voice off' : 'Turn the voice on';
    el.voice.setAttribute('aria-label', label);
    el.voice.title = label;
    render();
  });

  el.approvals.addEventListener('click', () => {
    if (!approvals.length) showNotice('Nothing is waiting for approval');
    else el.approval.hidden = !el.approval.hidden;
  });
  el.approvalAllow.addEventListener('click', () => answerApproval(true));
  el.approvalDeny.addEventListener('click', () => answerApproval(false));

  // The gear opens the settings card. (Opening the session in a terminal
  // is in the right-click menu.)
  el.gear.addEventListener('click', () => toggleSettings());

  el.close.addEventListener('click', () => api.quit());

  // Typing as a fallback for speaking: "Type a message" in the right-click
  // menu, or a double-click on the thread name.
  el.readout.addEventListener('dblclick', openTyping);
  const closeTyping = () => {
    el.typed.hidden = true;
    el.typed.value = '';
    el.session.hidden = false;
  };
  el.typed.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && el.typed.value.trim()) {
      const text = el.typed.value.trim();
      closeTyping();
      speaker.cancel();
      api.say(text);
    } else if (event.key === 'Escape') {
      closeTyping();
    }
  });
  el.typed.addEventListener('blur', closeTyping);

  window.addEventListener('contextmenu', (event) => {
    event.preventDefault();
    api.menu();
  });
  window.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape' || !el.typed.hidden) return;
    if (!el.settings.hidden) toggleSettings(false);
    else stopReply();
  });

  // Keep the window just tall enough for what is showing.
  new ResizeObserver(() => api.resize(el.stack.offsetHeight)).observe(el.stack);
}

async function startListening(settings) {
  listener = new Listener({
    silenceMs: settings.silenceMs,
    onLevel: (level) => {
      micLevel = level;
      document.documentElement.style.setProperty('--level', level.toFixed(3));
    },
    onStart: () => {
      view.hearing = true;
      // You cut in while the widget was talking. Awake, it stops at once;
      // asleep, only once you are heard saying its name ('heard').
      startedOverSpeech = Boolean(speaker?.speaking);
      sentenceAwake = view.awake;
      if (startedOverSpeech && view.awake) speaker.cancel();
      render();
    },
    onPartial: (audio) => {
      if (audio) api.partial(audio, startedOverSpeech);
    },
    onDiscard: () => {
      view.hearing = false;
      startedOverSpeech = false;
      if (el.heard.classList.contains('live')) hideHeard();
      releaseHeldReply();
      render();
    },
    onEnd: (audio) => {
      view.hearing = false;
      view.transcribing = true;
      render();
      api.utterance(audio, startedOverSpeech);
      startedOverSpeech = false;
      releaseHeldReply();
    },
    onLost: () => {
      view.micWorks = false;
      view.hearing = false;
      api.log('microphone disconnected');
      render();
    },
  });
  // A headset that connects later is picked up without restarting: at once
  // when Windows says a device changed, and every few seconds in case it
  // does not say so.
  navigator.mediaDevices.addEventListener('devicechange', checkMic);
  setInterval(checkMic, MIC_CHECK_MS);
  await openMic();
}

// The microphone comes back by itself. While it is on but not working (a
// headset dropped out) it is tried again every few seconds; while it works,
// it moves to Windows' default microphone when that changes. Never while you
// are mid-sentence.
const MIC_CHECK_MS = 3000;
let micChecking = false;
async function checkMic() {
  if (!view.micOn || !listener || micOpening || micChecking) return;
  if (!view.micWorks || !listener.running) {
    await openMic();
    return;
  }
  if (view.hearing) return;
  micChecking = true;
  try {
    if (await listener.stale()) {
      api.log('the default microphone changed; moving to it');
      await openMic();
    }
  } catch {
    // Looked again in a few seconds.
  } finally {
    micChecking = false;
  }
}

// After the PC wakes or is unlocked a microphone held from before can be
// silent without saying so: open it afresh.
function reopenMic() {
  if (view.micOn && !view.hearing) openMic();
}

let micOpening = false;
// The last reason it would not open, so a retry every few seconds logs a
// failure once rather than every time.
let micFailure = '';
async function openMic() {
  if (micOpening || !listener) return;
  micOpening = true;
  try {
    await listener.start();
    view.micWorks = true;
    micFailure = '';
    api.log(`microphone open: ${listener.deviceLabel || 'unnamed device'}`);
  } catch (error) {
    view.micWorks = false;
    const reason = `${error.name}: ${error.message}`;
    if (reason !== micFailure) api.log(`microphone unavailable: ${reason}; trying again every ${MIC_CHECK_MS / 1000} s`);
    micFailure = reason;
  } finally {
    micOpening = false;
  }
  // The mic may have been muted while it was opening.
  if (!view.micOn) listener.stop();
  render();
}

async function runDemo() {
  // Drives the widget through its states for the automated screenshot check.
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  document.body.classList.add('backdrop');
  await wait(700);
  api.shot('1-idle.png');
  await wait(300);
  api.say('Tell me what this widget does.');
  await wait(600);
  api.shot('2-thinking.png');
  await wait(3200);
  api.shot('3-speaking.png');
  await wait(9000);
  api.say('Run a command that needs permission.');
  await wait(1800);
  api.shot('4-approval.png');
  await wait(500);
  api.quit();
}

// Appearance: 'dark', 'light', or 'system' (follows the Windows app theme).
const systemDark = window.matchMedia('(prefers-color-scheme: dark)');
function applyTheme(choice) {
  const theme = choice === 'system' ? (systemDark.matches ? 'dark' : 'light') : choice === 'light' ? 'light' : 'dark';
  document.documentElement.dataset.theme = theme;
  orb.setTheme(theme);
}
systemDark.addEventListener('change', () => applyTheme(settings?.theme));

// The settings card.
let panel = null; // what the main process offers: voices, follow choices, speed range

function choice(label, checked, onPick, { tick = false } = {}) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'choice';
  button.setAttribute('role', 'radio');
  button.setAttribute('aria-checked', String(checked));
  if (tick) {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '0 0 12 12');
    svg.setAttribute('class', 'tick');
    svg.setAttribute('aria-hidden', 'true');
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('d', 'M2.5 6.2l2.3 2.3 4.7-5');
    svg.append(path);
    button.append(svg);
  }
  const text = document.createElement('span');
  text.textContent = label;
  button.append(text);
  button.addEventListener('click', onPick);
  return button;
}

function renderSettings() {
  if (!panel || !settings) return;
  el.setVoices.replaceChildren(
    ...panel.voices.map((voice) => {
      const option = document.createElement('option');
      option.value = voice.id;
      option.textContent = voice.label;
      option.selected = voice.id === settings.ttsVoice;
      return option;
    }),
  );
  el.setSpeed.min = panel.speed.min;
  el.setSpeed.max = panel.speed.max;
  el.setSpeed.step = panel.speed.step;
  el.setSpeed.value = settings.ttsSpeed;
  el.setSpeedValue.textContent = `${Number(settings.ttsSpeed).toFixed(2)}x`;
  el.setFollow.replaceChildren(
    ...panel.follow.map((ms) => choice(`${ms / 1000} s`, ms === settings.wakeFollowMs, () => saveSettings({ wakeFollowMs: ms }))),
  );
  el.setWake.replaceChildren(
    choice('On', settings.wakeWordOn, () => saveSettings({ wakeWordOn: true })),
    choice('Off', !settings.wakeWordOn, () => saveSettings({ wakeWordOn: false })),
  );
  el.setTheme.replaceChildren(
    ...[
      ['dark', 'Dark'],
      ['light', 'Light'],
      ['system', 'Match Windows'],
    ].map(([id, label]) => choice(label, settings.theme === id, () => saveSettings({ theme: id }))),
  );
}

async function saveSettings(patch) {
  settings = await api.setSettings(patch);
  applySettings();
  renderSettings();
}

function applySettings() {
  applyTheme(settings.theme);
  // The slider drives the Windows voice too, when it is the one speaking.
  if (windowsVoice) windowsVoice.rate = settings.ttsSpeed;
}

async function pickVoice(voice) {
  await saveSettings({ ttsVoice: voice.id });
  // Say something in the new voice straight away.
  speaker.cancel();
  speaker.say(`Hi, I'm ${voice.label.split(',')[0]}. This is how I sound.`);
}

async function toggleSettings(open = el.settings.hidden) {
  if (open) {
    panel = await api.settings();
    settings = panel.settings;
    renderSettings();
  }
  el.settings.hidden = !open;
  el.gear.setAttribute('aria-expanded', String(open));
}

function wireSettings() {
  // The value shows while dragging; the choice is saved when it is let go.
  el.setSpeed.addEventListener('input', () => {
    el.setSpeedValue.textContent = `${Number(el.setSpeed.value).toFixed(2)}x`;
  });
  el.setSpeed.addEventListener('change', () => saveSettings({ ttsSpeed: Number(el.setSpeed.value) }));
  el.setVoices.addEventListener('change', () => {
    const voice = panel?.voices.find((item) => item.id === el.setVoices.value);
    if (voice) pickVoice(voice);
  });
}

// Screenshot run for the wake states, the glows, the settings card and both
// themes. Drives the display only; nothing is heard or sent.
async function runLooksDemo() {
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const shoot = async (name) => {
    await wait(700);
    api.shot(`${name}.png`);
    const r = el.orb.getBoundingClientRect();
    api.shot(`${name}-orb.png`, { x: Math.round(r.left - 18), y: Math.round(r.top - 18), width: Math.round(r.width + 36), height: Math.round(r.height + 36) });
    await wait(300);
  };
  demo.on = true;
  document.body.classList.add('backdrop');
  view.connected = true;
  view.micWorks = true;
  view.title = 'Ember sync test (throwaway)';
  for (const theme of ['dark', 'light']) {
    applyTheme(theme);
    // Asleep, while noise is being picked up: nothing shows.
    Object.assign(view, { awake: false, hearing: true, transcribing: false });
    demo.level = 0.8;
    render();
    await shoot(`${theme}-1-asleep`);
    Object.assign(view, { awake: true, hearing: false });
    render();
    await shoot(`${theme}-2-awake`);
    view.hearing = true;
    demo.level = 0.75;
    render();
    await shoot(`${theme}-3-hearing`);
    view.hearing = false;
    demo.speaking = true;
    demo.outLevel = 0.6;
    render();
    await shoot(`${theme}-4-speaking`);
    demo.speaking = false;
    render();
    await toggleSettings(true);
    // Show the theme being pictured as the ticked one (not saved).
    settings.theme = theme;
    renderSettings();
    await shoot(`${theme}-5-settings`);
    await toggleSettings(false);
  }
  await wait(300);
  api.quit();
}

async function main() {
  const hello = await api.hello();
  view.mock = hello.mock;
  view.midTurn = Boolean(hello.midTurn);
  view.awake = hello.wake ? hello.wake.awake : true;
  settings = hello.settings;
  // The natural voice when it is chosen, with the Windows voice taking over
  // by itself if it cannot load or fails later.
  windowsVoice = new Speaker({ voiceName: hello.voiceName, rate: settings?.ttsSpeed ?? hello.voiceRate, onChange: render, onLog: api.log });
  speaker = hello.neuralVoice
    ? new NeuralSpeaker({ synth: (text) => api.tts(text), stopSynth: () => api.ttsStop(), fallback: windowsVoice, onChange: render, onLog: api.log })
    : windowsVoice;
  if (settings) applySettings();
  wireControls();
  wireSettings();
  api.onEvent(handle);
  render();
  requestAnimationFrame(animateBloom);
  if (hello.demo && hello.demoSet === 'looks') {
    runLooksDemo();
    return;
  }
  await startListening(hello);
  if (hello.demo) runDemo();
}

main();
