// Keeps the bar where you can see it.
//
// Windows can drop a floating window under ordinary ones while Electron still
// reports it as always on top (seen on a live bar under the maximised Claude
// app), most likely around a locked screen, sleep, or a screen change. So:
//   - the bar has a taskbar button: when it has slipped behind, one click
//     there brings it back to the front (wireTaskbarReturn), and
//   - it comes back by itself after the PC wakes or is unlocked and after
//     any screen change (createTopKeeper().poke).
//
// Clicking the button of a window that is already in front would normally
// minimise it; the bar has nowhere to minimise to, so it stays up instead.
//
// Pure logic, for the tests: the window is passed in.
import { bringToFront } from './bring-to-front.mjs';

export function createTopKeeper({ getWin, raise = bringToFront, onLog }) {
  return {
    // Something that is known to knock windows about just happened.
    poke(why) {
      const win = getWin();
      if (!win || win.isDestroyed?.()) return;
      raise(win);
      onLog?.(`back on top: ${why}`);
    },
  };
}

export function wireTaskbarReturn(win, { raise = bringToFront, onLog } = {}) {
  // A click on its taskbar button activates the window; put it in front of
  // the on-top band as well, not only above ordinary windows.
  win.on('focus', () => raise(win));
  // A second click on the button of the window in front minimises it.
  win.on('minimize', () => {
    win.restore();
    raise(win);
    onLog?.('back on top: its taskbar button was clicked');
  });
}

// The taskbar button's name: the thread, so several bars can be told apart.
export function taskbarTitle(threadTitle) {
  const title = String(threadTitle ?? '').trim();
  return title ? `Ember, ${title}` : 'Ember';
}
