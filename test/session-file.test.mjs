import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import * as fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { findSessionFile } from '../lib/sessions.mjs';

const ID = '67977faf-1014-4f2b-a6e0-8ce8f011df86';

test('the thread history file is found in whichever project folder holds it', () => {
  const projects = mkdtempSync(path.join(os.tmpdir(), 'ember-projects-'));
  mkdirSync(path.join(projects, 'C--some-other-folder'));
  mkdirSync(path.join(projects, 'C--Users-x-Dev-Workflow'));
  writeFileSync(path.join(projects, 'C--Users-x-Dev-Workflow', `${ID}.jsonl`), '{}\n');
  const found = findSessionFile(ID, projects, { fs });
  assert.equal(path.normalize(found), path.join(projects, 'C--Users-x-Dev-Workflow', `${ID}.jsonl`));
});

test('no history file, or a bad id, gives null instead of throwing', () => {
  const projects = mkdtempSync(path.join(os.tmpdir(), 'ember-projects-'));
  assert.equal(findSessionFile(ID, projects, { fs }), null);
  assert.equal(findSessionFile('../../etc', projects, { fs }), null);
  assert.equal(findSessionFile(ID, path.join(projects, 'missing'), { fs }), null);
});
