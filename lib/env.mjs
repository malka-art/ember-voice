// A running Claude Code session hands its own connection details to every
// command it starts. The widget opens a session of its own, so those details
// must not leak into it: they point at the launching session's link to its
// host app, not at the Claude Code sign-in on this computer.
export function withoutHostSession(base) {
  const env = { ...base };
  const inside = Boolean(env.CLAUDECODE);
  for (const key of Object.keys(env)) {
    if (key === 'ELECTRON_RUN_AS_NODE') delete env[key];
    if (!inside) continue;
    if (key === 'CLAUDECODE' || key === 'ANTHROPIC_BASE_URL') delete env[key];
    else if (key.startsWith('CLAUDE_') && key !== 'CLAUDE_CONFIG_DIR') delete env[key];
  }
  return env;
}
