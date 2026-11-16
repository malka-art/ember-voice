import assert from 'node:assert/strict';
import test from 'node:test';

import { createWakeGate } from '../lib/wake.mjs';

test('wake: with no wake word everything heard is sent on', () => {
  const gate = createWakeGate({ word: '' });
  assert.deepEqual(gate.check('What time is it?', 0), { text: 'What time is it?' });
});

test('wake: speech without the name is ignored', () => {
  const gate = createWakeGate({ word: 'ember' });
  assert.deepEqual(gate.check('for feeders because of us.', 1000), { ignored: true });
});

test('wake: the name is taken off the front, with or without a greeting', () => {
  const gate = createWakeGate({ word: 'ember' });
  assert.deepEqual(gate.check('Ember, what is seven plus five?', 0), { text: 'What is seven plus five?' });
  assert.deepEqual(gate.check('Hey Ember what did we decide', 0), { text: 'What did we decide' });
  assert.deepEqual(gate.check('Okay, Ember. Run the tests.', 0), { text: 'Run the tests.' });
});

test('wake: near misses of the name count', () => {
  const gate = createWakeGate({ word: 'ember' });
  assert.deepEqual(gate.check('Amber, open the manual.', 0), { text: 'Open the manual.' });
  assert.deepEqual(gate.check('Embers, open the manual.', 0), { text: 'Open the manual.' });
});

test('wake: a word that only starts like the name is not the name', () => {
  const gate = createWakeGate({ word: 'ember' });
  assert.deepEqual(gate.check('Embarrassing, that was.', 0), { ignored: true });
  assert.deepEqual(gate.check('I remember that.', 0), { ignored: true });
});

test('wake: the name alone opens the window for the next sentence', () => {
  const gate = createWakeGate({ word: 'ember', followMs: 5000 });
  assert.deepEqual(gate.check('Ember.', 0), { called: true });
  assert.deepEqual(gate.check('What is next?', 3000), { text: 'What is next?' });
});

test('wake: a follow-up needs no name, until the window closes', () => {
  const gate = createWakeGate({ word: 'ember', followMs: 5000 });
  gate.check('Ember, hello.', 0);
  gate.touch(10000); // the reply finished being spoken
  assert.deepEqual(gate.check('And then?', 14000), { text: 'And then?' });
  assert.deepEqual(gate.check('Unrelated chatter.', 30000), { ignored: true });
});
