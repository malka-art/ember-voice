import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ThreadBridge, NOT_LISTENING, NO_THREAD, STOPPED_HELP, isRetryable, linkFilePath } from '../lib/thread-bridge.mjs';

const STOPPED = 'the session was stopped and nobody has sent input since';

// A bridge with its own link file, a clock the test moves, and a stand-in
// for the mod that talks to it the way the real one does.
async function setup(options = {}) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'ember-thread-'));
  const linkFile = path.join(dir, 'thread-link.json');
  let clock = 1000;
  const bridge = new ThreadBridge(
    {},
    { linkFile, pollHoldMs: 150, graceMs: 8000, now: () => clock, ...options },
  );
  const seen = [];
  for (const name of ['ready', 'thinking', 'turn-started', 'done', 'error', 'offline', 'notice', 'progress']) {
    bridge.on(name, (payload) => seen.push([name, payload]));
  }
  const link = () => JSON.parse(readFileSync(linkFile, 'utf8'));
  const call = async (route, body, token) => {
    const { port, token: real } = link();
    const response = await fetch(`http://127.0.0.1:${port}${route}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-ember-token': token ?? real },
      body: JSON.stringify(body),
    });
    return { status: response.status, body: await response.json() };
  };
  const mod = (sessionId) => ({
    poll: (extra = {}) => call('/poll', { sessionId, version: 't', isBusy: false, ...extra }),
    event: (event) => call('/event', { sessionId, ...event }),
  });
  const names = () => seen.map(([name]) => name);
  const close = async () => {
    await bridge.stop();
    rmSync(dir, { recursive: true, force: true });
  };
  return { bridge, seen, names, link, linkFile, call, mod, close, tick: (ms) => (clock += ms) };
}

test('thread: the link names one session, on this computer only, with a secret', async () => {
  const t = await setup();
  await t.bridge.start({ sessionId: 'sess-a', cwd: '/x' });
  const link = t.link();
  assert.equal(link.sessionId, 'sess-a');
  assert.equal(link.token.length, 64);
  assert.equal(t.bridge.server.address().address, '127.0.0.1');
  // Without the secret nothing is said and nothing is accepted.
  assert.equal((await t.call('/poll', { sessionId: 'sess-a' }, 'wrong')).status, 403);
  assert.deepEqual(t.names(), []);
  await t.close();
  assert.equal(existsSync(t.linkFile), false, 'the link is removed when the bar closes');
});

test('thread: only the chosen thread is spoken to; another is told to let go', async () => {
  const t = await setup();
  await t.bridge.start({ sessionId: 'sess-a' });
  const other = await t.mod('sess-b').poll();
  assert.deepEqual(other.body, { unlink: true });
  assert.deepEqual(t.names(), []);

  const open = t.mod('sess-a').poll();
  await new Promise((resolve) => t.bridge.once('ready', resolve));
  t.bridge.send('hello thread');
  const answer = (await open).body;
  assert.equal(answer.say.length, 1);
  assert.equal(answer.say[0].text, 'hello thread');
  // The other thread still gets nothing, even with words waiting.
  t.bridge.send('second');
  assert.deepEqual((await t.mod('sess-b').poll()).body, { unlink: true });
  assert.equal((await t.mod('sess-a').poll()).body.say[0].text, 'second');

  // Switching threads lets go of the old one mid-poll.
  const held = t.mod('sess-a').poll();
  await new Promise((resolve) => setTimeout(resolve, 30));
  await t.bridge.start({ sessionId: 'sess-b' });
  assert.equal((await held).body.unlink, true);
  assert.equal(t.link().sessionId, 'sess-b');
  assert.deepEqual((await t.mod('sess-a').poll()).body, { unlink: true });
  await t.close();
});

test('thread: a turn is thinking, then its reply, spoken or typed in the app', async () => {
  const t = await setup();
  await t.bridge.start({ sessionId: 'sess-a' });
  const m = t.mod('sess-a');
  const open = m.poll();
  await new Promise((resolve) => t.bridge.once('ready', resolve));
  t.bridge.send('what time is it');
  const { say } = (await open).body;
  await m.event({ type: 'submitted', id: say[0].id });
  await m.event({ type: 'turn-start' });
  await m.event({ type: 'turn-complete', reason: 'answer', text: 'It is noon. Lunch time.' });
  assert.deepEqual(t.names(), ['ready', 'turn-started', 'thinking', 'done']);
  assert.deepEqual(t.seen.at(-1)[1], { text: 'It is noon. Lunch time.', isError: false, streamed: false, spoken: false });
  assert.equal(t.bridge.busy, false);

  // Text written mid-turn is passed on at once; a reply already spoken that
  // way is marked so it is not read a second time.
  await m.event({ type: 'turn-start' });
  await m.event({ type: 'progress', text: 'Checking the logs now.' });
  assert.deepEqual(t.seen.at(-1), ['progress', { text: 'Checking the logs now.' }]);
  await m.event({ type: 'turn-complete', reason: 'answer', text: 'Checking the logs now.', spoken: true });
  assert.equal(t.seen.at(-1)[1].spoken, true);

  // A turn nobody spoke (typed in the app) is read aloud the same way.
  await m.event({ type: 'turn-start' });
  await m.event({ type: 'turn-complete', reason: 'answer', text: 'Typed reply.' });
  assert.equal(t.seen.at(-1)[1].text, 'Typed reply.');

  // Stopping from the bar keeps the thread's turn but drops its reply.
  await m.event({ type: 'turn-start' });
  await t.bridge.interrupt();
  await m.event({ type: 'turn-complete', reason: 'answer', text: 'Not wanted.' });
  assert.equal(t.seen.at(-1)[1].text, '');
  // A failed turn says so instead of going silent.
  await m.event({ type: 'turn-start' });
  await m.event({ type: 'turn-complete', reason: 'error', text: '' });
  assert.equal(t.seen.at(-1)[1].isError, true);
  assert.match(t.seen.at(-1)[1].text, /could not finish/);
  await t.close();
});

test('thread: an empty poll comes back by itself; a thread already mid-turn is shown as busy', async () => {
  const t = await setup();
  await t.bridge.start({ sessionId: 'sess-a' });
  const began = Date.now();
  const first = await t.mod('sess-a').poll();
  assert.ok(Date.now() - began >= 100, 'the poll was held open');
  assert.equal(first.body.say, undefined);

  const u = await setup();
  await u.bridge.start({ sessionId: 'sess-a' });
  const started = new Promise((resolve) => u.bridge.once('turn-started', resolve));
  const open = u.mod('sess-a').poll({ isBusy: true });
  await started;
  assert.deepEqual(u.names(), ['ready', 'turn-started']);
  await open;
  await t.close();
  await u.close();
});

test('thread: a thread that is not listening is said plainly, and no words are kept for it', async () => {
  const t = await setup();
  await t.bridge.start({ sessionId: 'sess-a' });
  t.tick(5000);
  t.bridge.check();
  assert.deepEqual(t.names(), [], 'still within the grace period');
  t.tick(4000);
  t.bridge.check();
  t.bridge.check();
  assert.equal(t.seen.length, 1);
  assert.deepEqual(t.seen[0], ['offline', { message: NOT_LISTENING, status: 'Thread is not listening', spoken: 'That thread is not listening.' }]);

  // Speaking into the void is refused out loud, never queued for later.
  t.bridge.send('is anyone there');
  assert.deepEqual(t.names(), ['offline', 'offline']);
  assert.equal(t.bridge.queue.length, 0);

  // The thread wakes up: ready again, and it does not get the old words.
  const m = t.mod('sess-a');
  const first = await m.poll();
  assert.equal(first.body.say, undefined);
  assert.deepEqual(t.names().slice(2), ['ready', 'notice']);

  // It goes quiet again (its process ended): noticed after the silence limit.
  t.tick(t.bridge.gapMs - 1000);
  t.bridge.check();
  assert.equal(t.bridge.listening, true, 'a short gap between polls is normal');
  t.tick(1001);
  t.bridge.check();
  assert.equal(t.names().at(-1), 'offline');
  assert.equal(t.bridge.listening, false);
  await t.close();
});

test('thread: words refused by a stopped thread are sent again after something is typed there', async () => {
  const t = await setup();
  await t.bridge.start({ sessionId: 'sess-a' });
  const m = t.mod('sess-a');
  const open = m.poll();
  await new Promise((resolve) => t.bridge.once('ready', resolve));
  t.bridge.send('carry on');
  const { say } = (await open).body;
  await m.event({ type: 'dropped', id: say[0].id, reason: STOPPED });
  assert.deepEqual(t.seen.at(-1), ['error', { message: STOPPED_HELP }]);
  // The stopped turn's own ending does not count as "something was typed".
  await m.event({ type: 'turn-complete', reason: 'aborted', text: '' });
  assert.equal(t.bridge.queue.length, 0);
  // You type in the thread; that turn ends; the kept words go out.
  await m.event({ type: 'turn-start' });
  await m.event({ type: 'turn-complete', reason: 'answer', text: 'Back.' });
  const again = (await m.poll()).body;
  assert.equal(again.say[0].text, 'carry on');

  // Refused again, but by now too old to be worth sending.
  await m.event({ type: 'dropped', id: again.say[0].id, reason: STOPPED });
  t.tick(200000);
  await m.event({ type: 'turn-complete', reason: 'answer', text: 'Later.' });
  assert.equal((await m.poll()).body.say, undefined);

  // Any other refusal is reported, not retried.
  t.bridge.send('x');
  const third = (await m.poll()).body;
  await m.event({ type: 'dropped', id: third.say[0].id, reason: 'the run reached its --max-turns limit' });
  assert.match(t.seen.at(-1)[1].message, /did not take that/);
  assert.equal(t.bridge.held.length, 0);
  assert.equal(isRetryable('the prompt was removed from the queue before it ran'), true);
  assert.equal(isRetryable('nope'), false);
  await t.close();
});

test('thread: with no thread chosen it says how to choose one, and writes no link', async () => {
  const t = await setup();
  await t.bridge.start({ sessionId: null });
  assert.deepEqual(t.seen, [['offline', { message: NO_THREAD, status: 'No thread chosen', spoken: '' }]]);
  assert.equal(existsSync(t.linkFile), false);
  t.bridge.send('hello');
  assert.deepEqual(t.names(), ['offline', 'offline']);
  await assert.rejects(t.bridge.setModel('m'), /chosen in the thread/);
  // A newer bar's link is not removed by an older bar closing.
  await t.bridge.start({ sessionId: 'sess-a' });
  writeFileSync(t.linkFile, JSON.stringify({ sessionId: 'sess-z', port: 1, token: 'someone-else' }));
  t.bridge.dispose();
  assert.equal(existsSync(t.linkFile), true);
  // One link per thread, so a bar per thread can be open at once.
  assert.equal(linkFilePath({ APPDATA: 'C:/a' }, 'sess-a'), path.join('C:/a', 'ember-voice', 'thread-links', 'sess-a.json'));
  assert.equal(linkFilePath({ APPDATA: 'C:/a' }), null);
  assert.equal(linkFilePath({}, 'sess-a'), null);
  await t.close();
});

test('thread: the mod and the bar agree on the version, and an older mod is pointed out', async () => {
  const mod = new URL('../mod/ember-thread/', import.meta.url);
  const manifest = JSON.parse(readFileSync(new URL('.claude-plugin/plugin.json', mod), 'utf8'));
  const source = readFileSync(new URL('hooks/register.js', mod), 'utf8');
  assert.equal(source.match(/const VERSION = '([^']+)'/)[1], manifest.version);
  // The mod must never write files or keep reply text anywhere but the bar.
  assert.equal(/\$\.fs\.write|\$\.store\.|\$\.process\./.test(source), false);

  const t = await setup({ expectedVersion: manifest.version });
  await t.bridge.start({ sessionId: 'sess-a' });
  await t.mod('sess-a').poll({ version: '0.0.1' });
  assert.match(t.seen.at(-1)[1].message, /older Ember mod/);
  await t.close();
});
