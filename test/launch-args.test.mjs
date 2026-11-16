import assert from 'node:assert/strict';
import test from 'node:test';

import { joinValueFlags, parseArgs } from '../lib/sessions.mjs';

const ID = '67977faf-1014-4f2b-a6e0-8ce8f011df86';

// What Electron's "second-instance" event delivers on Windows: Chromium puts
// every switch first and every plain argument after them.
function reorderLikeChromium(argv) {
  return [...argv.filter((a) => a.startsWith('--')), ...argv.filter((a) => !a.startsWith('--'))];
}

test('regr_ember_switch: the old spaced form loses the thread when the bar is already open', () => {
  const spaced = ['C:\\dev\\ember-voice', '--session', ID, '--cwd', 'C:\\work'];
  assert.equal(parseArgs(reorderLikeChromium(spaced)).session, null);
});

test('regr_ember_switch: the joined form keeps the thread through the reorder', () => {
  const joined = ['C:\\dev\\ember-voice', ...joinValueFlags(['--session', ID, '--cwd', 'C:\\work'])];
  const args = parseArgs(reorderLikeChromium(joined));
  assert.equal(args.session, ID);
  assert.equal(args.cwd, 'C:\\work');
});

test('joinValueFlags leaves other arguments alone', () => {
  assert.deepEqual(joinValueFlags(['--quit']), ['--quit']);
  assert.deepEqual(joinValueFlags(['--latest', '--cwd', 'C:\\a b']), ['--latest', '--cwd=C:\\a b']);
  assert.deepEqual(joinValueFlags(['--session']), ['--session']);
});
