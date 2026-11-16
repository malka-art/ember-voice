#!/usr/bin/env node
// Adds an /ember command to Claude Code. Typing /ember in any session opens
// the widget attached to that exact session.
//
// It is not called /voice because Claude Code already has a built-in /voice
// (its own dictation), and the two would collide.
//
//   npm run install-command               install
//   npm run install-command -- --remove   uninstall

import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const launcher = path.join(root, 'scripts', 'launch.mjs').replace(/\\/g, '/');
const configDir = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
const skillDir = path.join(configDir, 'skills', 'ember');
const skillFile = path.join(skillDir, 'SKILL.md');

export const skill = `---
name: ember
description: Open the Ember voice bar on this thread so the user can talk to it out loud, and switch this thread into voice conversation. Use when the user types /ember or asks to talk to this thread by voice.
allowed-tools: Bash(node:*)
---

The user has just connected the Ember voice bar to this thread.

First, run this exact command with the Bash tool, changing nothing:

\`\`\`
node "${launcher}" --session \${CLAUDE_SESSION_ID}
\`\`\`

Then keep the following in mind for the rest of this thread. It comes from the
user, who typed /ember.

## How this thread works from now on

- Ember is a small voice bar on the user's desktop. When the user speaks to it,
  Ember turns their speech into text on their computer and types it into this
  thread as their own message. When you reply, Ember reads your reply aloud.
- So the user's messages may be spoken, not typed. When they ask whether you
  can hear them, are listening, or heard something, they mean: did their words
  reach this thread? If the message arrived, the answer is yes. Never tell them
  that you cannot hear or only read text. Through Ember, you can hear them.
- Speech-to-text sometimes mishears. If a message reads as garbled or
  unrelated, say in a few words what you think they meant and ask, instead of
  saying you did not understand.
- The user may be talking with other people in the room. Ember only passes on
  what starts with its name, "Ember", plus whatever they say in the short
  moment after you answer, so a stray sentence can still slip in. If a message
  clearly was not meant for you, ignore it with a one-line reply.
- Your replies are heard, not read. Keep them short and conversational: one to
  three plain spoken sentences. No markdown, lists, tables, code blocks, file
  paths or emoji unless the user asks. Describe changes instead of reciting
  them. Do the work as usual; only the way you report it changes.

After running the command, reply with one short spoken-style line saying Ember
is connected and you can hear them. Do nothing else.
`;

// Writes the command, pointing at this folder's launcher. Also run by
// "npm run setup". Returns a line saying where it went.
export function installCommand() {
  mkdirSync(skillDir, { recursive: true });
  writeFileSync(skillFile, skill);
  return `Installed the /ember command at ${skillFile}. New Claude Code sessions have it.`;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.includes('--remove')) {
    rmSync(skillDir, { recursive: true, force: true });
    console.log(`Removed the /ember command (${skillDir}).`);
  } else {
    console.log(installCommand());
    console.log('Type /ember in any session.');
  }
}
