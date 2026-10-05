import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { Vault } from '../server/vault.js';
import { start } from '../server/app.js';
import { extractLinks, extractTags, resolveLink, rewriteLinks } from '../server/markdown.js';

let dir;
let vault;
beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'notes-test-'));
  vault = new Vault(dir);
  await vault.init();
});
afterEach(async () => {
  vault.close();
  await fs.rm(dir, { recursive: true, force: true });
});

test('a new vault is seeded with templates and a welcome note', async () => {
  const { notes } = await vault.refresh();
  assert.ok(notes.includes('Welcome.md'));
  assert.ok(notes.includes('Templates/Meeting Notes.md'));
  const templates = await vault.templates();
  const meeting = templates.find((t) => t.name === 'Meeting Notes');
  assert.deepEqual(meeting.prompts.map((p) => p.label), ['Meeting title', 'Attendees', 'Project']);
});

test('seeding never touches a non-empty vault', async () => {
  const other = await fs.mkdtemp(path.join(os.tmpdir(), 'notes-test-'));
  await fs.writeFile(path.join(other, 'mine.md'), 'hi');
  await fs.mkdir(path.join(other, 'Templates'));
  const v = new Vault(other);
  await v.init();
  assert.deepEqual((await v.refresh()).notes, ['mine.md']);
  await fs.rm(other, { recursive: true, force: true });
});

test('paths outside the vault are rejected', async () => {
  await assert.rejects(vault.read('../secret.md'), /outside the vault/);
  await assert.rejects(vault.write('../../x.md', 'x'), /outside the vault/);
  await assert.rejects(vault.read('Welcome.txt'), /Only .md/);
});

test('symlinks pointing outside the vault are rejected', async () => {
  const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'notes-outside-'));
  await fs.writeFile(path.join(outside, 'secret.md'), 'secret');
  await fs.symlink(outside, path.join(dir, 'link'));
  await assert.rejects(vault.read('link/secret.md'), /outside the vault/);
  await fs.rm(outside, { recursive: true, force: true });
});

test('creating from the meeting template files and names the note', async () => {
  const now = new Date(2026, 9, 5, 9, 30);
  const res = await vault.createFromTemplate({ template: 'Meeting Notes', answers: { 'Meeting title': 'Roadmap', Attendees: 'Ana', Project: 'Apollo' }, now });
  assert.equal(res.path, 'Meetings/2026-10-05 Roadmap.md');
  const { content } = await vault.read(res.path);
  assert.match(content, /^---\ntype: meeting\ndate: 2026-10-05/);
  assert.match(content, /\*\*Attendees:\*\* Ana/);
  assert.match(content, /\[\[Apollo\]\]/);
  assert.ok(!content.includes('{{'));
  assert.equal(content.slice(res.cursor - 2, res.cursor), '- ');

  const again = await vault.createFromTemplate({ template: 'Meeting Notes', answers: { 'Meeting title': 'Roadmap' }, now });
  assert.equal(again.path, 'Meetings/2026-10-05 Roadmap 1.md');
});

test('daily note is created once from the daily template', async () => {
  const now = new Date(2026, 9, 5);
  const first = await vault.daily(now);
  assert.deepEqual([first.path, first.created], ['Daily/2026-10-05.md', true]);
  assert.match((await vault.read(first.path)).content, /\[\[2026-10-04\]\] \| \[\[2026-10-06\]\]/);
  const second = await vault.daily(now);
  assert.equal(second.created, false);
});

test('backlinks, search and tags', async () => {
  await vault.write('Projects/Apollo.md', '# Apollo\n#project #q4');
  await vault.write('Standup.md', 'Discussed [[Apollo]] timeline.\nAlso Apollo budget.');
  await vault.write('Other.md', 'Apollo mentioned without a link');
  const { linked, unlinked } = await vault.backlinks('Projects/Apollo.md');
  assert.deepEqual(linked.map((l) => l.path), ['Standup.md']);
  assert.ok(unlinked.some((l) => l.path === 'Other.md'));

  const results = await vault.search('apollo timeline');
  assert.equal(results[0].path, 'Standup.md');
  assert.deepEqual((await vault.search('#q4')).map((r) => r.path), ['Projects/Apollo.md']);
  const tags = await vault.tags();
  assert.ok(tags.some((t) => t.tag === 'q4'));
});

test('renaming a note rewrites links to it', async () => {
  await vault.write('Apollo.md', '# Apollo');
  await vault.write('A.md', 'See [[Apollo]], [[Apollo|the project]] and [[Apollo#Goals]]. Not [[Apollonia]].');
  const res = await vault.rename('Apollo.md', 'Projects/Apollo Program.md');
  assert.deepEqual(res.updated, ['A.md']);
  assert.equal((await vault.read('A.md')).content, 'See [[Apollo Program]], [[Apollo Program|the project]] and [[Apollo Program#Goals]]. Not [[Apollonia]].');
});

test('renaming a folder moves its notes and updates path links', async () => {
  await vault.write('Old/Note.md', 'x');
  await vault.write('Ref.md', '[[Old/Note]] and [[Note]]');
  await vault.rename('Old', 'New');
  assert.deepEqual((await vault.refresh()).notes.filter((n) => n.endsWith('/Note.md')), ['New/Note.md']);
  assert.equal((await vault.read('Ref.md')).content, '[[New/Note]] and [[Note]]');
});

test('deleting moves to .trash', async () => {
  await vault.write('Gone.md', 'bye');
  const res = await vault.remove('Gone.md');
  assert.match(res.trashed, /^\.trash\//);
  assert.ok(!(await vault.refresh()).notes.includes('Gone.md'));
  assert.equal(await fs.readFile(path.join(dir, res.trashed), 'utf8'), 'bye');
});

test('stale writes are rejected', async () => {
  const { mtime } = await vault.write('C.md', 'one');
  await new Promise((r) => setTimeout(r, 20));
  await fs.writeFile(path.join(dir, 'C.md'), 'changed elsewhere');
  await assert.rejects(vault.write('C.md', 'two', { baseMtime: mtime }), /changed on disk/);
});

test('link and tag extraction ignores code', () => {
  const text = '---\ntags: [alpha, beta]\n---\n[[A]] ![[B#x|y]] `[[C]]` #real\n```\n[[D]] #fake\n```\n# Heading';
  assert.deepEqual(extractLinks(text), ['A', 'B']);
  assert.deepEqual(extractTags(text).sort(), ['alpha', 'beta', 'real']);
  assert.equal(resolveLink('note', ['a/Note.md', 'Note.md']), 'Note.md');
  assert.equal(resolveLink('a/note', ['a/Note.md', 'Note.md']), 'a/Note.md');
  assert.equal(rewriteLinks('[[x]] [[y]]', 'x.md', 'z.md', ['x.md', 'y.md']), '[[z]] [[y]]');
});

test('HTTP API rejects cross-site and foreign-host requests', async () => {
  const { server, url } = await start({ vaultPath: dir, port: 0, watch: false });
  try {
    const ok = await fetch(url + '/api/tree', { headers: { 'X-Notes-App': '1' } });
    assert.equal(ok.status, 200);
    assert.equal((await fetch(url + '/api/tree')).status, 403, 'missing custom header');
    const foreign = await new Promise((resolve, reject) => {
      http.get(url + '/api/tree', { headers: { 'X-Notes-App': '1', Host: 'evil.example' } }, (res) => { res.resume(); resolve(res.statusCode); }).on('error', reject);
    });
    assert.equal(foreign, 403, 'foreign host (DNS rebinding)');
    const cross = await fetch(url + '/api/tree', { headers: { 'X-Notes-App': '1', 'Sec-Fetch-Site': 'cross-site' } });
    assert.equal(cross.status, 403, 'cross-site');
    const traversal = await fetch(url + '/api/note?path=../x.md', { headers: { 'X-Notes-App': '1' } });
    assert.equal(traversal.status, 400);
    assert.equal((await fetch(url + '/')).status, 200);
  } finally {
    server.close();
  }
});
