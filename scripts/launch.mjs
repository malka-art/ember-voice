#!/usr/bin/env node
// Starts the widget and returns straight away, so a terminal or a Claude Code
// session that launches it is not left waiting.
//
//   node scripts/launch.mjs                      a new session in this folder; or, when
//                                                run from inside a Claude Code session,
//                                                that session
//   node scripts/launch.mjs --session <id>       a specific session
//   node scripts/launch.mjs --latest             the most recent session in this folder
//   node scripts/launch.mjs --new                a brand new session
//   node scripts/launch.mjs --mic-test           real microphone, stand-in for Claude
//   node scripts/launch.mjs --mock               preview with no microphone or Claude
//   node scripts/launch.mjs --quit               close this thread's bar (run inside a
//                                                thread); from a plain terminal, every bar
//   node scripts/launch.mjs --quit --session <id>  close that thread's bar only
//   node scripts/launch.mjs --quit --all         close every bar that is open
//
// In thread mode each thread has a bar of its own, so /ember in a second
// thread opens a second bar.

import { spawn } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { withoutHostSession } from '../lib/env.mjs';
import { isSessionId, joinValueFlags, parseArgs } from '../lib/sessions.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);

let electron;
try {
  electron = require('electron');
} catch {
  console.error(`Electron is not installed yet. Run "npm install" in ${root} first.`);
  process.exit(1);
}

const args = process.argv.slice(2);
if (!args.some((arg) => arg === '--cwd' || arg.startsWith('--cwd='))) args.push('--cwd', process.cwd());

// Started from inside a Claude Code session with no session named: attach to
// that session. This also covers a /ember command whose session id was not
// filled in.
const wanted = parseArgs(args);
const hostSession = process.env.CLAUDE_CODE_SESSION_ID;
// "--all": every bar (only with --quit). Not a widget flag, so not passed on.
const all = args.includes('--all');
if (all) args.splice(args.indexOf('--all'), 1);
// From inside a thread, "--quit" means that thread's own bar: restarting one
// bar must never close the others. Every bar takes "--quit --all", or a
// "--quit" run from an ordinary terminal (no thread to belong to).
if (!wanted.session && !wanted.fresh && !wanted.latest && !wanted.mock && !all && isSessionId(hostSession)) {
  args.push('--session', hostSession);
  wanted.session = hostSession;
}

// Drop the launching session's own markers so the widget's session starts clean.
const env = withoutHostSession(process.env);

// Values joined to their flags, so they survive being handed to a bar that is
// already open (see joinValueFlags).
function start(list) {
  const child = spawn(electron, [root, ...joinValueFlags(list)], { cwd: process.cwd(), env, detached: true, stdio: 'ignore' });
  child.on('error', (error) => {
    console.error(`The widget could not start: ${error.message}`);
    process.exit(1);
  });
  child.unref();
}

start(args);
// Closing every bar ("--quit --all", or "--quit" from a plain terminal):
// each thread's bar is its own program, found by the link file it keeps.
if (wanted.quit && !wanted.session && process.env.APPDATA) {
  let files = [];
  try {
    files = readdirSync(path.join(process.env.APPDATA, 'ember-voice', 'thread-links'));
  } catch {
    // No bars open.
  }
  for (const file of files) {
    const sessionId = file.replace(/\.json$/, '');
    if (file.endsWith('.json') && isSessionId(sessionId)) start(['--quit', '--session', sessionId]);
  }
}
console.log(wanted.quit ? 'Ember voice widget asked to close.' : 'Ember voice widget started.');
