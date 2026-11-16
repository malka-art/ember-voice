// Works out which Claude Code session the widget should attach to.

const SESSION_ID = /^[0-9a-f-]{8,64}$/i;

export function isSessionId(value) {
  return typeof value === 'string' && SESSION_ID.test(value);
}

// Turns "--session <id>" into "--session=<id>" (and the same for --cwd).
// When the bar is already open, Electron hands a second launch's arguments to
// it through Chromium, which moves every switch in front of every plain
// argument. A value written after its flag then ends up far from it and is
// lost, so /ember could never move an open bar to a new thread. Joined with
// "=", the value stays attached to its flag.
export function joinValueFlags(args) {
  const out = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if ((arg === '--session' || arg === '--cwd') && i + 1 < args.length && !args[i + 1].startsWith('--')) {
      out.push(`${arg}=${args[++i]}`);
    } else {
      out.push(arg);
    }
  }
  return out;
}

export function parseArgs(argv) {
  const out = { session: null, cwd: null, fresh: false, latest: false, mock: false, micTest: false, quit: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--session' && argv[i + 1]) out.session = argv[++i];
    else if (arg.startsWith('--session=')) out.session = arg.slice(10);
    else if (arg === '--cwd' && argv[i + 1]) out.cwd = argv[++i];
    else if (arg.startsWith('--cwd=')) out.cwd = arg.slice(6);
    else if (arg === '--new') out.fresh = true;
    else if (arg === '--latest') out.latest = true;
    else if (arg === '--mock') out.mock = true;
    else if (arg === '--mic-test') out.micTest = true;
    else if (arg === '--quit') out.quit = true;
  }
  if (!isSessionId(out.session)) out.session = null;
  // The mic test uses the real microphone and speech model with a stand-in
  // for Claude, so it spends no usage.
  if (out.micTest) out.mock = true;
  return out;
}

// Where Claude Code keeps a session's saved history: one file per session,
// <config>/projects/<folder name>/<session id>.jsonl. Returns null when it is
// not there (yet).
export function findSessionFile(sessionId, projectsDir, { fs }) {
  if (!isSessionId(sessionId)) return null;
  let folders;
  try {
    folders = fs.readdirSync(projectsDir, { withFileTypes: true });
  } catch {
    return null;
  }
  for (const folder of folders) {
    if (!folder.isDirectory()) continue;
    const file = `${projectsDir}/${folder.name}/${sessionId}.jsonl`;
    if (fs.existsSync(file)) return file;
  }
  return null;
}

export function sessionTitle(info) {
  const text = info?.customTitle || info?.summary || info?.firstPrompt || 'Untitled session';
  const oneLine = text.replace(/\s+/g, ' ').trim();
  return oneLine.length > 60 ? `${oneLine.slice(0, 57)}...` : oneLine;
}

// Order of preference:
//   1. the session named on the command line (what /ember passes)
//   2. --latest: the most recent session in the folder the widget was started
//      from, or failing that the most recent session anywhere
//   3. a brand new session
//
// A plain start opens a new session on purpose. With several sessions live in
// one folder, "most recent" is whichever one happened to write last, and
// talking into the wrong thread is worse than starting a clean one. Any recent
// session is one right-click away in the widget's menu.
export async function resolveTarget(args, sdk, fallbackCwd) {
  const cwd = args.cwd || fallbackCwd;

  if (args.session) {
    let info;
    try {
      info = await sdk.getSessionInfo(args.session, { dir: cwd });
      info ??= await sdk.getSessionInfo(args.session);
    } catch {
      // Fall through and let the resume attempt report the problem.
    }
    return { sessionId: args.session, cwd: info?.cwd || cwd, title: sessionTitle(info), source: 'named' };
  }

  if (args.fresh || !args.latest) return { sessionId: null, cwd, title: 'New session', source: 'new' };

  for (const dir of [cwd, undefined]) {
    try {
      const [latest] = await sdk.listSessions({ dir, limit: 1, includeProgrammatic: false });
      if (latest) {
        return {
          sessionId: latest.sessionId,
          cwd: latest.cwd || cwd,
          title: sessionTitle(latest),
          source: dir ? 'latest-here' : 'latest-anywhere',
        };
      }
    } catch {
      // No sessions readable for this folder.
    }
  }

  return { sessionId: null, cwd, title: 'New session', source: 'new' };
}

export async function recentSessions(sdk, limit = 8) {
  try {
    const list = await sdk.listSessions({ limit, includeProgrammatic: false });
    return list.map((info) => ({ sessionId: info.sessionId, cwd: info.cwd, title: sessionTitle(info) }));
  } catch {
    return [];
  }
}
