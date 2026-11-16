// The app's settings, in three layers, each over the one before:
//   the defaults below
//   config.json        shared by everyone, in git; nothing about one PC
//   config.local.json  this PC's own settings (folders, the speech model);
//                      git ignores it, and setup writes the model choice here
// The settings panel's choices go on top of all three (lib/settings.mjs).

import { readFileSync } from 'node:fs';
import path from 'node:path';

export const LOCAL_CONFIG = 'config.local.json';

export const DEFAULTS = {
  model: 'claude-opus-5-5',
  models: [
    { id: 'claude-opus-5-5', label: 'Opus 5.5' },
    { id: 'claude-fable-5-2', label: 'Fable 5.2' },
  ],
  // 'own': the bar runs its own Claude Code session (a copy of a thread, or
  // a new one). 'thread': the bar is only a microphone and a speaker for a
  // thread open in the Claude app, through the ember-thread mod.
  mode: 'own',
  useApiKey: false,
  forkSession: true,
  sttEngine: 'auto',
  // The folder holding whisper-server.exe. Empty means the one setup makes,
  // <data folder>\whisper.
  whisperDir: '',
  // A model file name, looked for in <data folder>\speech-models and then in
  // whisperDir, or a full path. Empty means the best one on this PC
  // (pickWhisperModel in lib/stt.mjs).
  whisperModel: '',
  whisperThreads: 8,
  sttModel: 'onnx-community/whisper-base.en',
  sttDtype: null,
  sttDevice: null,
  silenceMs: 800,
  voiceName: '',
  voiceRate: 1.05,
  // 'neural': the Kokoro voice made on this PC (lib/neural-voice.mjs), with
  // the Windows voice as automatic fallback. 'windows': the Windows voice only.
  ttsEngine: 'windows',
  ttsVoice: 'af_heart',
  ttsSpeed: 1,
  // Where the Kokoro files are. Empty means <data folder>\voice-models.
  ttsModelDir: '',
  // The bar only acts on speech that starts with this name. '' = always.
  wakeWord: '',
  // How long after an exchange it still listens without the name.
  wakeFollowMs: 12000,
  spokenStyle: '',
};

function readJson(file) {
  try {
    const value = JSON.parse(readFileSync(file, 'utf8'));
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  } catch {
    return {};
  }
}

export function readLocalConfig(root) {
  return readJson(path.join(root, LOCAL_CONFIG));
}

export function loadConfig(root) {
  return { ...DEFAULTS, ...readJson(path.join(root, 'config.json')), ...readLocalConfig(root) };
}

// "%APPDATA%\x" -> "C:\Users\...\AppData\Roaming\x"; unknown names stay as written.
export function expandEnv(value, env = process.env) {
  return String(value ?? '').replace(/%([^%]+)%/g, (whole, name) => env[name] ?? env[name.toUpperCase()] ?? whole);
}
