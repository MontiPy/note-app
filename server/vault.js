import fs from 'node:fs/promises';
import { watch } from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { extractLinks, extractTags, resolveLink, rewriteLinks } from './markdown.js';
import { describeTemplate, formatDate, renderTemplate, sanitizeFileName } from './templates.js';
import { SEED_FILES } from './seed.js';

const IGNORED_DIRS = new Set(['node_modules']);
export const ATTACHMENT_TYPES = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
  '.webp': 'image/webp', '.svg': 'image/svg+xml', '.bmp': 'image/bmp', '.avif': 'image/avif',
  '.pdf': 'application/pdf', '.mp3': 'audio/mpeg', '.m4a': 'audio/mp4', '.wav': 'audio/wav', '.mp4': 'video/mp4',
};
const CONFIG_FILE = '.noteapp.json';
const DEFAULT_CONFIG = {
  templatesFolder: 'Templates',
  dailyFolder: 'Daily',
  dailyTemplate: 'Daily Note',
  dailyNameFormat: 'YYYY-MM-DD',
  newNoteFolder: '',
  attachmentsFolder: 'attachments',
};

export class VaultError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

const toPosix = (p) => p.split(path.sep).join('/');
const isNote = (name) => name.toLowerCase().endsWith('.md');

export class Vault extends EventEmitter {
  constructor(root) {
    super();
    this.root = path.resolve(root);
    this.index = new Map(); // relPath -> { mtimeMs, content, links, tags }
    this.recentWrites = new Map(); // relPath -> timestamp, to ignore our own fs events
  }

  async init({ seed = true } = {}) {
    await fs.mkdir(this.root, { recursive: true });
    this.root = await fs.realpath(this.root);
    if (seed) await this.seed();
    await this.refresh();
  }

  // Adds starter templates (and a welcome note for empty vaults) without
  // overwriting anything that already exists.
  async seed() {
    const entries = (await fs.readdir(this.root)).filter((e) => !e.startsWith('.'));
    const config = await this.getConfig();
    const hasTemplates = await fs.stat(path.join(this.root, config.templatesFolder)).then(() => true, () => false);
    for (const [rel, content] of Object.entries(SEED_FILES)) {
      const isTemplate = rel.startsWith('Templates/');
      if (isTemplate ? hasTemplates : entries.length > 0) continue;
      const target = isTemplate ? `${config.templatesFolder}/${rel.slice('Templates/'.length)}` : rel;
      const abs = this.abs(target);
      await fs.mkdir(path.dirname(abs), { recursive: true });
      await fs.writeFile(abs, content, { flag: 'wx' }).catch(() => {});
    }
  }

  // ---- paths -------------------------------------------------------------

  // Maps a vault-relative path to an absolute one, refusing anything outside the vault.
  abs(rel) {
    if (typeof rel !== 'string' || rel.includes('\0')) throw new VaultError(400, 'Invalid path');
    const clean = rel.replace(/\\/g, '/').replace(/^\/+/, '');
    const resolved = path.resolve(this.root, clean);
    if (resolved !== this.root && !resolved.startsWith(this.root + path.sep)) {
      throw new VaultError(400, 'Path is outside the vault');
    }
    return resolved;
  }

  rel(abs) { return toPosix(path.relative(this.root, abs)); }

  // Also guards against symlinks inside the vault that point outside it.
  async checkReal(abs) {
    let probe = abs;
    for (;;) {
      try {
        const real = await fs.realpath(probe);
        if (real !== this.root && !real.startsWith(this.root + path.sep)) throw new VaultError(400, 'Path is outside the vault');
        return;
      } catch (e) {
        if (e instanceof VaultError) throw e;
        const parent = path.dirname(probe);
        if (parent === probe) return;
        probe = parent;
      }
    }
  }

  noteAbs(rel) {
    if (!isNote(rel)) throw new VaultError(400, 'Only .md notes can be edited');
    return this.abs(rel);
  }

  // ---- config ------------------------------------------------------------

  async getConfig() {
    try {
      const raw = JSON.parse(await fs.readFile(path.join(this.root, CONFIG_FILE), 'utf8'));
      return { ...DEFAULT_CONFIG, ...raw };
    } catch {
      return { ...DEFAULT_CONFIG };
    }
  }

  async setConfig(patch) {
    const next = { ...(await this.getConfig()) };
    for (const key of Object.keys(DEFAULT_CONFIG)) {
      if (typeof patch[key] === 'string') next[key] = patch[key].trim().replace(/^\/+|\/+$/g, '');
    }
    await fs.writeFile(path.join(this.root, CONFIG_FILE), JSON.stringify(next, null, 2) + '\n');
    return next;
  }

  // ---- tree & index ------------------------------------------------------

  async walk(dir = this.root, out = { folders: [], notes: [], files: [] }) {
    let entries;
    try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch { return out; }
    for (const e of entries) {
      if (e.name.startsWith('.')) continue;
      const abs = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (IGNORED_DIRS.has(e.name)) continue;
        out.folders.push(this.rel(abs));
        await this.walk(abs, out);
      } else if (e.isFile() && isNote(e.name)) {
        out.notes.push(this.rel(abs));
      } else if (e.isFile() && ATTACHMENT_TYPES[path.extname(e.name).toLowerCase()]) {
        out.files.push(this.rel(abs));
      }
    }
    return out;
  }

  // Re-reads notes whose mtime changed since the last refresh.
  async refresh() {
    const { folders, notes, files } = await this.walk();
    this.files = files.sort((a, b) => a.localeCompare(b));
    const seen = new Set(notes);
    for (const key of this.index.keys()) if (!seen.has(key)) this.index.delete(key);
    await Promise.all(notes.map(async (rel) => {
      try {
        const stat = await fs.stat(this.abs(rel));
        const cached = this.index.get(rel);
        if (cached && cached.mtimeMs === stat.mtimeMs) return;
        const content = await fs.readFile(this.abs(rel), 'utf8');
        this.index.set(rel, { mtimeMs: stat.mtimeMs, content, links: extractLinks(content), tags: extractTags(content) });
      } catch { this.index.delete(rel); }
    }));
    this.folders = folders.sort((a, b) => a.localeCompare(b));
    return { folders: this.folders, notes: this.notePaths(), files: this.files };
  }

  notePaths() { return [...this.index.keys()].sort((a, b) => a.localeCompare(b)); }

  async tree() {
    const { folders, notes, files } = await this.refresh();
    const config = await this.getConfig();
    return {
      folders,
      files,
      notes: notes.map((p) => ({ path: p, mtime: this.index.get(p).mtimeMs })),
      templatesFolder: config.templatesFolder,
    };
  }

  // ---- notes -------------------------------------------------------------

  markWrite(rel) { this.recentWrites.set(rel, Date.now()); }

  async read(rel) {
    const abs = this.noteAbs(rel);
    await this.checkReal(abs);
    try {
      const [content, stat] = await Promise.all([fs.readFile(abs, 'utf8'), fs.stat(abs)]);
      return { path: rel, content, mtime: stat.mtimeMs };
    } catch (e) {
      if (e.code === 'ENOENT') throw new VaultError(404, 'Note not found');
      throw e;
    }
  }

  async write(rel, content, { create = false, baseMtime } = {}) {
    if (typeof content !== 'string') throw new VaultError(400, 'Content must be a string');
    const abs = this.noteAbs(rel);
    await this.checkReal(abs);
    if (!create && baseMtime) {
      // Reject saves made against a version that changed on disk meanwhile.
      const stat = await fs.stat(abs).catch(() => null);
      if (stat && Math.abs(stat.mtimeMs - baseMtime) > 1) throw new VaultError(409, 'Note changed on disk');
    }
    await fs.mkdir(path.dirname(abs), { recursive: true });
    this.markWrite(rel);
    try {
      await fs.writeFile(abs, content, create ? { flag: 'wx' } : undefined);
    } catch (e) {
      if (e.code === 'EEXIST') throw new VaultError(409, 'A note with that name already exists');
      throw e;
    }
    const stat = await fs.stat(abs);
    this.index.set(rel, { mtimeMs: stat.mtimeMs, content, links: extractLinks(content), tags: extractTags(content) });
    return { path: rel, mtime: stat.mtimeMs };
  }

  async uniquePath(folder, title) {
    const base = sanitizeFileName(title) || 'Untitled';
    const dir = folder ? folder.replace(/^\/+|\/+$/g, '') + '/' : '';
    for (let i = 0; ; i++) {
      const rel = `${dir}${base}${i ? ' ' + i : ''}.md`;
      const exists = await fs.stat(this.abs(rel)).then(() => true, () => false);
      if (!exists) return rel;
    }
  }

  async createNote({ folder, title = 'Untitled', content }) {
    const config = await this.getConfig();
    const rel = await this.uniquePath(folder ?? config.newNoteFolder, title);
    return this.write(rel, content ?? '', { create: true });
  }

  async mkdir(rel) {
    const abs = this.abs(rel);
    await this.checkReal(abs);
    await fs.mkdir(abs, { recursive: true });
    return { path: rel };
  }

  // Renames/moves a note or folder and rewrites [[links]] that pointed at it.
  async rename(from, to) {
    const fromAbs = this.abs(from);
    const stat = await fs.stat(fromAbs).catch(() => null);
    if (!stat) throw new VaultError(404, 'Not found');
    if (stat.isFile() && !isNote(to)) to += '.md';
    const toAbs = this.abs(to);
    await Promise.all([this.checkReal(fromAbs), this.checkReal(toAbs)]);
    if (fromAbs === toAbs) return { path: to, updated: [] };
    if (await fs.stat(toAbs).then(() => true, () => false)) {
      // Allow case-only renames on case-insensitive file systems.
      if (fromAbs.toLowerCase() !== toAbs.toLowerCase()) throw new VaultError(409, 'Something with that name already exists');
    }
    if (stat.isDirectory() && toAbs.startsWith(fromAbs + path.sep)) throw new VaultError(400, 'Cannot move a folder into itself');

    await this.refresh();
    const before = this.notePaths();
    const moves = stat.isDirectory()
      ? before.filter((p) => p.startsWith(from + '/')).map((p) => [p, to + p.slice(from.length)])
      : [[from, to]];

    await fs.mkdir(path.dirname(toAbs), { recursive: true });
    for (const [, newPath] of moves) this.markWrite(newPath);
    await fs.rename(fromAbs, toAbs);

    const updated = [];
    const renamedFrom = new Map(moves);
    for (const [notePath, entry] of [...this.index.entries()]) {
      let next = entry.content;
      for (const [oldP, newP] of moves) next = rewriteLinks(next, oldP, newP, before);
      if (next === entry.content) continue;
      const current = renamedFrom.get(notePath) ?? notePath;
      this.markWrite(current);
      await fs.writeFile(this.abs(current), next);
      updated.push(current);
    }
    await this.refresh();
    return { path: to, updated };
  }

  // Moves notes and folders to <vault>/.trash rather than deleting them.
  async remove(rel) {
    const abs = this.abs(rel);
    if (abs === this.root) throw new VaultError(400, 'Cannot delete the vault');
    await this.checkReal(abs);
    if (!(await fs.stat(abs).catch(() => null))) throw new VaultError(404, 'Not found');
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const dest = path.join(this.root, '.trash', `${stamp} ${path.basename(abs)}`);
    await fs.mkdir(path.dirname(dest), { recursive: true });
    this.markWrite(rel);
    await fs.rename(abs, dest);
    await this.refresh();
    return { trashed: this.rel(dest) };
  }

  // ---- attachments -------------------------------------------------------

  async readFile(rel) {
    const type = ATTACHMENT_TYPES[path.extname(rel).toLowerCase()];
    if (!type) throw new VaultError(404, 'Not found');
    const abs = this.abs(rel);
    await this.checkReal(abs);
    try { return { body: await fs.readFile(abs), type }; } catch { throw new VaultError(404, 'Not found'); }
  }

  // Saves a pasted/dropped file into the attachments folder and returns its path.
  async saveAttachment({ name, data }) {
    const ext = path.extname(name || '').toLowerCase();
    if (!ATTACHMENT_TYPES[ext]) throw new VaultError(400, 'Unsupported file type');
    if (typeof data !== 'string') throw new VaultError(400, 'Missing data');
    const { attachmentsFolder } = await this.getConfig();
    const base = sanitizeFileName(path.basename(name, ext)) || 'Pasted file';
    const dir = attachmentsFolder ? attachmentsFolder + '/' : '';
    for (let i = 0; ; i++) {
      const rel = `${dir}${base}${i ? ' ' + i : ''}${ext}`;
      const abs = this.abs(rel);
      await fs.mkdir(path.dirname(abs), { recursive: true });
      try {
        this.markWrite(rel);
        await fs.writeFile(abs, Buffer.from(data, 'base64'), { flag: 'wx' });
        this.files = [...(this.files ?? []), rel].sort((a, b) => a.localeCompare(b));
        return { path: rel };
      } catch (e) { if (e.code !== 'EEXIST') throw e; }
    }
  }

  // ---- queries -----------------------------------------------------------

  async backlinks(rel) {
    await this.refresh();
    const paths = this.notePaths();
    const name = rel.split('/').pop().replace(/\.md$/i, '');
    const linked = [];
    const unlinked = [];
    const nameRe = new RegExp(`\\b${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i');
    for (const [p, entry] of this.index) {
      if (p === rel) continue;
      if (entry.links.some((l) => resolveLink(l, paths) === rel)) {
        linked.push({ path: p, snippets: snippetsAround(entry.content, (line) => /\[\[/.test(line) && entry.links.some((l) => line.includes(l))) });
      } else if (name.length > 2 && nameRe.test(entry.content)) {
        unlinked.push({ path: p, snippets: snippetsAround(entry.content, (line) => nameRe.test(line)) });
      }
    }
    return { linked, unlinked };
  }

  async search(query) {
    await this.refresh();
    const q = query.trim().toLowerCase();
    if (!q) return [];
    const terms = q.split(/\s+/);
    const results = [];
    for (const [p, entry] of this.index) {
      const hay = entry.content.toLowerCase();
      const name = p.toLowerCase();
      const matches = terms.every((t) => (t.startsWith('#') ? entry.tags.includes(t.slice(1)) || hay.includes(t) : hay.includes(t) || name.includes(t)));
      if (!matches) continue;
      const score = terms.reduce((s, t) => s + (name.includes(t) ? 10 : 0) + Math.min(hay.split(t).length - 1, 5), 0);
      results.push({
        path: p,
        score,
        snippets: snippetsAround(entry.content, (line) => terms.some((t) => line.toLowerCase().includes(t))),
      });
    }
    return results.sort((a, b) => b.score - a.score || a.path.localeCompare(b.path)).slice(0, 100);
  }

  async tags() {
    await this.refresh();
    const counts = new Map();
    for (const entry of this.index.values()) for (const t of entry.tags) counts.set(t, (counts.get(t) ?? 0) + 1);
    return [...counts].map(([tag, count]) => ({ tag, count })).sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag));
  }

  // ---- templates ---------------------------------------------------------

  async templates() {
    await this.refresh();
    const { templatesFolder } = await this.getConfig();
    const prefix = templatesFolder ? templatesFolder + '/' : '';
    return this.notePaths()
      .filter((p) => p.startsWith(prefix))
      .map((p) => ({
        path: p,
        name: p.slice(prefix.length).replace(/\.md$/i, ''),
        ...describeTemplate(this.index.get(p).content),
      }));
  }

  async findTemplate(name) {
    const all = await this.templates();
    const t = all.find((x) => x.path === name || x.name.toLowerCase() === String(name).toLowerCase());
    if (!t) throw new VaultError(404, `Template "${name}" not found`);
    return t;
  }

  async createFromTemplate({ template, title, answers, folder, now = new Date() }) {
    const t = await this.findTemplate(template);
    const rendered = renderTemplate(this.index.get(t.path).content, { title, answers: answers ?? {}, folder, now });
    const rel = await this.uniquePath(rendered.folder, rendered.title);
    const res = await this.write(rel, rendered.content, { create: true });
    return { ...res, cursor: rendered.cursor };
  }

  // Opens today's daily note, creating it from the daily template if needed.
  async daily(now = new Date()) {
    const config = await this.getConfig();
    const title = formatDate(now, config.dailyNameFormat);
    const rel = `${config.dailyFolder ? config.dailyFolder + '/' : ''}${sanitizeFileName(title)}.md`;
    if (await fs.stat(this.abs(rel)).then(() => true, () => false)) return { path: rel, created: false, cursor: -1 };
    let content = `# ${title}\n\n`;
    let cursor = content.length;
    try {
      const t = await this.findTemplate(config.dailyTemplate);
      const rendered = renderTemplate(this.index.get(t.path).content, { title, now, folder: config.dailyFolder });
      content = rendered.content;
      cursor = rendered.cursor;
    } catch (e) { if (!(e instanceof VaultError)) throw e; }
    await this.write(rel, content, { create: true });
    return { path: rel, created: true, cursor };
  }

  // ---- watching ----------------------------------------------------------

  // Emits 'change' when files are edited outside the app (another editor, sync, git).
  watch() {
    let timer;
    const pending = new Set();
    try {
      this.watcher = watch(this.root, { recursive: true }, (_event, filename) => {
        if (!filename) return;
        const rel = toPosix(filename.toString());
        if (rel.split('/').some((s) => s.startsWith('.'))) return;
        const own = this.recentWrites.get(rel);
        if (own && Date.now() - own < 1500) return;
        pending.add(rel);
        clearTimeout(timer);
        timer = setTimeout(async () => {
          const paths = [...pending];
          pending.clear();
          await this.refresh().catch(() => {});
          this.emit('change', { paths });
        }, 200);
      });
    } catch {
      // Recursive watching is unsupported on some platforms; the UI still refreshes on focus.
    }
  }

  close() { this.watcher?.close(); }
}

function snippetsAround(content, predicate, max = 3) {
  const out = [];
  for (const line of content.split(/\r?\n/)) {
    if (predicate(line)) out.push(line.trim().slice(0, 240));
    if (out.length >= max) break;
  }
  return out;
}
