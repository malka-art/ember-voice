// Tells the window whether the bar is awake (listening without its name) or
// asleep (waiting for "Ember"), each time that changes: when the name is
// heard, when an exchange keeps the window open, and when the window runs out.
//
//   const watch = createWakeWatch({ gate: () => wakeGate, onChange })
//   watch.update()   call after anything that may have changed the gate
//   watch.state()    { awake, remainingMs } right now
//   watch.dispose()
//
// `gate` is a function so the gate can be replaced (a settings change)
// without rewiring. Pure logic with injectable timers, for the tests.

export function createWakeWatch({ gate, onChange, now = () => Date.now(), setTimer = setTimeout, clearTimer = clearTimeout }) {
  let timer = null;
  let last = null;

  function state() {
    const remaining = gate().remaining(now());
    return { awake: remaining > 0, remainingMs: Number.isFinite(remaining) ? remaining : null };
  }

  function update() {
    const current = state();
    if (timer !== null) {
      clearTimer(timer);
      timer = null;
    }
    // Look again just after the window would close.
    if (current.awake && current.remainingMs !== null) timer = setTimer(update, current.remainingMs + 20);
    // Asleep is reported once; while awake every extension is reported, so
    // the window always knows how long is left.
    const changed = last === null || last.awake !== current.awake || (current.awake && last.remainingMs !== current.remainingMs);
    if (changed) onChange(current);
    last = current;
    return current;
  }

  return {
    state,
    update,
    dispose() {
      if (timer !== null) clearTimer(timer);
      timer = null;
    },
  };
}
