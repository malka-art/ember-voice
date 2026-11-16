import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSpokenMemory, looksLikeEcho } from '../lib/echo.mjs';

const reply = 'I measured it, and Ember is not the slow part. Most of the wait is me thinking before I write anything.';

test('echo: the bar hearing its own words back is caught', () => {
  assert.equal(looksLikeEcho('most of the wait is me thinking before I write', [reply]), true);
  assert.equal(looksLikeEcho('Ember is not the slow part', [reply]), true);
});

test('echo: your own words are kept, even when they share common words', () => {
  assert.equal(looksLikeEcho('okay whatever, I want you to do the thing instead', [reply]), false);
  assert.equal(looksLikeEcho('stop, that is not what I asked about at all', [reply]), false);
});

test('echo: one or two words are always hers', () => {
  assert.equal(looksLikeEcho('okay stop', [reply]), false);
  assert.equal(looksLikeEcho('the wait', [reply]), false);
});

test('echo: what was spoken long ago is forgotten', () => {
  let clock = 0;
  const memory = createSpokenMemory({ now: () => clock, keepMs: 1000 });
  memory.remember(reply);
  assert.equal(memory.isEcho('most of the wait is me thinking'), true);
  clock = 5000;
  assert.equal(memory.isEcho('most of the wait is me thinking'), false);
});
