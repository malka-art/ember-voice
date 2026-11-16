import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createWakeGate, nameFromTitle } from '../lib/wake.mjs';

test('wake: a short thread name wakes the bar as well as its own name', () => {
  const gate = createWakeGate({ word: 'ember', followMs: 1000, also: [nameFromTitle('Juniper')] });
  assert.deepEqual(gate.check('Juniper, what is next', 0), { text: 'What is next' });
  assert.deepEqual(gate.check('Ember, and now', 5000), { text: 'And now' });
  assert.deepEqual(gate.check('Amber, and now', 9000), { text: 'And now' });
  assert.deepEqual(gate.check('Carolina is nice', 99000), { ignored: true });
});

test('wake: a long thread title is not used as a name', () => {
  assert.equal(nameFromTitle('Juniper'), 'juniper');
  assert.equal(nameFromTitle("Robin's notes"), "robin's notes");
  assert.equal(nameFromTitle("Dashboard: apply Sam's chosen look"), '');
});

test('wake: with other bars open, only its own name wakes it', () => {
  const gate = createWakeGate({ word: 'ember', followMs: 1000, also: ['juniper'] });
  gate.rename({ word: 'juniper', others: ['robin'] });
  assert.deepEqual(gate.check('Ember, hello', 0), { ignored: true });
  assert.deepEqual(gate.check('Juniper, hello', 10), { text: 'Hello' });
});

test('wake: a sentence for another bar is never taken, even in the no-name window', () => {
  const gate = createWakeGate({ word: 'juniper', followMs: 60000, others: ['robin'] });
  assert.deepEqual(gate.check('Juniper, start', 0), { text: 'Start' });
  // Inside the window, plain speech is still hers...
  assert.deepEqual(gate.check('and then this', 10), { text: 'and then this' });
  // ...but speech that opens with the other bar's name is not.
  assert.deepEqual(gate.check('Robin, what about you', 20), { ignored: true, other: true });
  // ...and hearing the other bar's name puts this one to sleep at once.
  assert.equal(gate.remaining(21), 0);
  assert.deepEqual(gate.check('and back to you', 30), { ignored: true });
});

test('wake: hearing the other bar name mid-sentence puts this bar to sleep', () => {
  const gate = createWakeGate({ word: 'juniper', followMs: 60000, others: ['robin'] });
  gate.touch(0);
  assert.ok(gate.remaining(10) > 0);
  assert.deepEqual(gate.peek('Robin, what', 10), { awake: false, called: false, text: '', other: true });
  assert.equal(gate.remaining(11), 0);
  // Its own name still wakes it.
  assert.deepEqual(gate.check('Juniper, I am back', 20), { text: 'I am back' });
});

test('wake: a look mid-sentence changes nothing', () => {
  const gate = createWakeGate({ word: 'ember', followMs: 1000 });
  assert.deepEqual(gate.peek('Ember, can you', 0), { awake: true, called: true, text: 'Can you' });
  assert.deepEqual(gate.peek('just talking', 0), { awake: false, called: false, text: '' });
  // Peeking at the name did not open the no-name window.
  assert.deepEqual(gate.check('just talking', 10), { ignored: true });
});
