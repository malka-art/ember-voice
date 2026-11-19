import assert from 'node:assert/strict';
import test from 'node:test';

import { bringToFront } from '../lib/bring-to-front.mjs';

function fakeWindow({ destroyed = false } = {}) {
  const calls = [];
  return {
    calls,
    isDestroyed: () => destroyed,
    setAlwaysOnTop: (...args) => calls.push(['setAlwaysOnTop', ...args]),
    showInactive: () => calls.push(['showInactive']),
    moveTop: () => calls.push(['moveTop']),
  };
}

test('regr_bar_to_top: a second launch puts the bar back on top without taking focus', () => {
  const win = fakeWindow();
  bringToFront(win);
  assert.deepEqual(win.calls, [['setAlwaysOnTop', true, 'floating'], ['showInactive'], ['moveTop']]);
});

test('bringToFront does nothing without a live window', () => {
  assert.doesNotThrow(() => bringToFront(null));
  const gone = fakeWindow({ destroyed: true });
  bringToFront(gone);
  assert.deepEqual(gone.calls, []);
});
