// The choices made in the bar's settings panel, kept per user in
// %APPDATA%\ember-voice\settings.json and laid over code/config.json, so the
// project's config is never rewritten by the app.

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';

// The natural voices offered, with plain names.
export const VOICE_CHOICES = [
  { id: 'af_heart', label: 'Heart, American woman' },
  { id: 'af_bella', label: 'Bella, American woman' },
  { id: 'af_nicole', label: 'Nicole, American woman, soft' },
  { id: 'af_sarah', label: 'Sarah, American woman' },
  { id: 'am_michael', label: 'Michael, American man' },
  { id: 'am_fenrir', label: 'Fenrir, American man' },
  { id: 'am_puck', label: 'Puck, American man' },
  { id: 'bf_emma', label: 'Emma, British woman' },
  { id: 'bm_george', label: 'George, British man' },
  { id: 'bm_fable', label: 'Fable, British man' },
];

export const FOLLOW_CHOICES = [10000, 15000, 30000, 60000];
export const THEMES = ['dark', 'light', 'system'];
export const SPEED = { min: 0.8, max: 1.6, step: 0.05 };

// Keeps only known keys with sensible values; anything else is dropped.
export function cleanSettings(input) {
  const out = {};
  const s = input && typeof input === 'object' ? input : {};
  if (VOICE_CHOICES.some((v) => v.id === s.ttsVoice)) out.ttsVoice = s.ttsVoice;
  const speed = Number(s.ttsSpeed);
  if (Number.isFinite(speed)) {
    const stepped = Math.round(Math.min(SPEED.max, Math.max(SPEED.min, speed)) / SPEED.step) * SPEED.step;
    out.ttsSpeed = Math.round(stepped * 100) / 100;
  }
  if (FOLLOW_CHOICES.includes(Number(s.wakeFollowMs))) out.wakeFollowMs = Number(s.wakeFollowMs);
  if (typeof s.wakeWordOn === 'boolean') out.wakeWordOn = s.wakeWordOn;
  if (THEMES.includes(s.theme)) out.theme = s.theme;
  return out;
}

export function readSettings(file) {
  try {
    return cleanSettings(JSON.parse(readFileSync(file, 'utf8')));
  } catch {
    return {};
  }
}

// Writes to a temporary file first, so a crash never leaves half a file.
export function writeSettings(file, settings) {
  mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.tmp`;
  writeFileSync(temp, `${JSON.stringify(cleanSettings(settings), null, 2)}\n`);
  renameSync(temp, file);
}

// What the bar actually uses: config.json, with the user's choices on top.
export function effectiveSettings(config, saved) {
  const s = cleanSettings(saved);
  return {
    ttsVoice: s.ttsVoice ?? config.ttsVoice ?? 'af_heart',
    ttsSpeed: s.ttsSpeed ?? config.ttsSpeed ?? 1,
    wakeFollowMs: s.wakeFollowMs ?? config.wakeFollowMs ?? 15000,
    wakeWordOn: s.wakeWordOn ?? Boolean(String(config.wakeWord ?? '').trim()),
    wakeWord: String(config.wakeWord ?? '').trim(),
    theme: s.theme ?? config.theme ?? 'dark',
  };
}

// Saves a change and returns the new effective settings.
export function updateSettings(file, config, patch) {
  const next = { ...readSettings(file), ...cleanSettings(patch) };
  writeSettings(file, next);
  return effectiveSettings(config, next);
}
