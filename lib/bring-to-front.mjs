// Brings an open bar back above every other window, without taking focus.
//
// Windows can leave an always-on-top window with its flag still set but
// stacked below ordinary windows (seen on a live bar: topmost, yet under the
// maximised Claude app). Showing an already visible window does not change its
// stacking, so a second /ember could not bring it back. Setting the level again
// puts it back in the topmost band, and moveTop raises it to the front of it.
export function bringToFront(win) {
  if (!win || win.isDestroyed?.()) return;
  win.setAlwaysOnTop(true, 'floating');
  win.showInactive();
  win.moveTop();
}
