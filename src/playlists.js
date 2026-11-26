/**
 * Playlists — main-process side.
 *
 * A playlist is a named, ordered list of media paths. Each one is a small JSON
 * file, <name>.maidenplaylist, in a folder the operator can open and back up
 * (Documents/MaidenPlayer Playlists). Nothing is copied: the list points at
 * the files where they are.
 *
 *   { "version": 1, "name": "Dailies", "repeat": false,
 *     "modified": "2026-11-26T07:30:00.000Z",
 *     "items": [{ "path": "D:\\clips\\a.mov" }] }
 *
 * Thumbnails are a convenience and live in the app's own profile folder, keyed
 * by path + size + modified time, so a changed file gets a new picture.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFile } = require('child_process');

const EXT = '.maidenplaylist';
const MAX_ITEMS = 2000;

let cfg = { dir: null, thumbDir: null, ffmpeg: null, probeFile: null, dcp: null };

function configure(opts) { cfg = Object.assign(cfg, opts); }

function ensureDir(dir) { fs.mkdirSync(dir, { recursive: true }); return dir; }

/** A name the file system will take, on Windows as well as macOS. */
function safeName(name) {
  const cleaned = String(name || '').replace(/[<>:"/\\|?*\x00-\x1f]/g, ' ').replace(/\s+/g, ' ').replace(/[. ]+$/, '').trim();
  return (cleaned || 'Playlist').slice(0, 80);
}

/** Only files of ours, in our folder — the renderer hands these paths back. */
function ownFile(file) {
  if (typeof file !== 'string' || !file) return null;
  const resolved = path.resolve(file);
  if (path.dirname(resolved) !== path.resolve(cfg.dir)) return null;
  if (path.extname(resolved).toLowerCase() !== EXT) return null;
  return resolved;
}

function readPlaylist(file) {
  const data = JSON.parse(fs.readFileSync(file, 'utf8'));
  const items = Array.isArray(data.items) ? data.items : [];
  return {
    file,
    name: typeof data.name === 'string' && data.name ? data.name : path.basename(file, EXT),
    repeat: !!data.repeat,
    items: items.filter((i) => i && typeof i.path === 'string' && i.path).slice(0, MAX_ITEMS).map((i) => ({ path: i.path })),
  };
}

/** Every playlist in the folder, newest change first. */
function list() {
  const dir = ensureDir(cfg.dir);
  const out = [];
  for (const entry of fs.readdirSync(dir)) {
    if (path.extname(entry).toLowerCase() !== EXT) continue;
    const file = path.join(dir, entry);
    try {
      const p = readPlaylist(file);
      out.push({ file, name: p.name, count: p.items.length, modified: fs.statSync(file).mtimeMs });
    } catch (_) { /* not a playlist we can read: leave it alone */ }
  }
  return out.sort((a, b) => b.modified - a.modified);
}

function load(file) {
  const own = ownFile(file);
  if (!own || !fs.existsSync(own)) return { error: 'That playlist is no longer in the playlists folder.' };
  try { return readPlaylist(own); } catch (err) { return { error: 'This playlist could not be read: ' + err.message }; }
}

/**
 * Write a playlist. A new one, or one whose name changed, gets the file name
 * that matches — and never lands on top of a different playlist.
 */
function save(playlist) {
  const dir = ensureDir(cfg.dir);
  const name = safeName(playlist && playlist.name);
  const previous = ownFile(playlist && playlist.file);
  let target = path.join(dir, name + EXT);
  const same = (a, b) => a && b && a.toLowerCase() === b.toLowerCase();
  for (let n = 2; fs.existsSync(target) && !same(target, previous); n++) {
    target = path.join(dir, name + ' (' + n + ')' + EXT);
  }
  const items = (Array.isArray(playlist.items) ? playlist.items : [])
    .filter((i) => i && typeof i.path === 'string' && i.path).slice(0, MAX_ITEMS).map((i) => ({ path: i.path }));
  const body = JSON.stringify({ version: 1, name, repeat: !!playlist.repeat, modified: new Date().toISOString(), items }, null, 2);
  const tmp = target + '.tmp';
  fs.writeFileSync(tmp, body);
  fs.renameSync(tmp, target);
  if (previous && !same(previous, target)) { try { fs.unlinkSync(previous); } catch (_) { /* already gone */ } }
  return { file: target, name, repeat: !!playlist.repeat, items };
}

function remove(file) {
  const own = ownFile(file);
  if (!own) return { error: 'That is not a playlist file.' };
  try { fs.unlinkSync(own); } catch (err) { if (err.code !== 'ENOENT') return { error: err.message }; }
  return { ok: true };
}

// ─── What an entry looks like in the list ────────────────────────────────────

function thumbKey(file) {
  const st = fs.statSync(file);
  return crypto.createHash('sha1').update(file + '|' + st.size + '|' + st.mtimeMs).digest('hex');
}

/** One small JPEG from a little way into the picture. → data URL, or null. */
function makeThumb(mediaPath, at, inputOpts) {
  return new Promise((resolve) => {
    let out;
    try { out = path.join(ensureDir(cfg.thumbDir), thumbKey(mediaPath) + '.jpg'); } catch (_) { resolve(null); return; }
    const asUrl = () => {
      try { return 'data:image/jpeg;base64,' + fs.readFileSync(out).toString('base64'); } catch (_) { return null; }
    };
    if (fs.existsSync(out)) { resolve(asUrl()); return; }
    const args = ['-hide_banner', '-loglevel', 'error', '-ss', String(Math.max(0, at || 0))]
      .concat(inputOpts || [], ['-i', mediaPath, '-frames:v', '1', '-an', '-vf', 'scale=192:-2', '-q:v', '5', '-y', out]);
    execFile(cfg.ffmpeg, args, { windowsHide: true, timeout: 25000 }, (err) => {
      if (err) { try { fs.unlinkSync(out); } catch (_) { /* nothing written */ } resolve(null); return; }
      resolve(asUrl());
    });
  });
}

/**
 * Name, running time and thumbnail for one entry. A DCP is listed by its
 * composition title and pictured from its first reel; an encrypted one has no
 * thumbnail (its picture is noise without the key) but still plays.
 */
async function itemInfo(itemPath) {
  const info = { path: itemPath, name: path.basename(String(itemPath || '')), duration: 0, thumb: null, missing: false, kind: 'file' };
  let stat;
  try { stat = fs.statSync(itemPath); } catch (_) { info.missing = true; return info; }

  try {
    const ext = path.extname(itemPath).toLowerCase();
    const found = (stat.isDirectory() || ext === '.xml' || ext === '.mxf') && cfg.dcp ? cfg.dcp.resolve(itemPath) : null;
    if (found && found.cpls && found.cpls.length) {
      const cpl = found.cpls.find((c) => c.path === found.preferred) || found.cpls[0];
      const comp = cfg.dcp.parseCpl(cpl.path);
      info.kind = 'dcp';
      info.name = comp.title || cpl.title || info.name;
      info.duration = comp.duration > 0 ? comp.duration : 0;
      const picture = comp.reels[0] && comp.reels[0].picture;
      if (picture && picture.path && !picture.keyId && fs.existsSync(picture.path)) {
        info.thumb = await makeThumb(picture.path, 1, ['-lowres', '2']);
      }
      return info;
    }
    if (stat.isDirectory()) { info.kind = 'folder'; return info; }

    const probe = await cfg.probeFile(itemPath);
    if (probe && !probe.error) info.duration = probe.duration || 0;
    info.thumb = await makeThumb(itemPath, info.duration > 4 ? Math.min(info.duration * 0.1, 20) : 0);
  } catch (err) {
    console.warn('[Playlists] item info:', err.message);
  }
  return info;
}

module.exports = { configure, list, load, save, remove, itemInfo, EXT };
