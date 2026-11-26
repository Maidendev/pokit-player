/**
 * MaidenPlayer — DCP (Digital Cinema Package) playback
 *
 * A DCP is not a file, it is a folder: an ASSETMAP naming every asset by
 * UUID, a Composition Playlist (CPL) that lists reels, and per reel one
 * picture track file (JPEG 2000 in MXF, X'Y'Z' 12-bit) and one sound track
 * file (24-bit PCM in MXF). The CPL says which stretch of each track file is
 * played — EntryPoint and Duration, in frames.
 *
 * This module turns that into something the rest of the player already
 * understands:
 *
 *   resolve(path)   any path inside a DCP (the folder, ASSETMAP, PKL, CPL or
 *                   a track file) → the CPLs it contains. A CPL's path is
 *                   what the player then treats as "the file".
 *   probe(cplPath)  a probe result shaped like transcoder.probeFile()'s, with
 *                   isDcp set and the parsed composition attached.
 *   inputArgs(...)  the ffmpeg inputs that play the composition as ONE
 *                   continuous timeline from any position.
 *
 * The reels are joined with ffmpeg's concat demuxer (one script for picture,
 * one for sound) rather than one input per reel: a feature has 5–8 reels, and
 * a JPEG 2000 decoder per reel, all open at once, would cost a thread pool
 * and frame buffers each. Checked frame by frame on ffmpeg 6.1 with burnt-in
 * frame numbers: the join lands on the exact frame, and so does a start from
 * the middle of any reel (see writeScripts for how a seek is expressed).
 *
 * Version files are played by finding the package they borrow from (see
 * resolveForeign), and encrypted ones with the keys from a KDM (dcp-kdm.js).
 *
 * Not handled, and reported rather than played wrong: stereoscopic 3D.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const transcoder = require('./transcoder');
const kdm = require('./dcp-kdm');
const { TrackFile } = require('./dcp-mxf');

const SCRIPT_DIR = path.join(os.tmpdir(), 'maidenplayer-dcp');

// ---------------------------------------------------------------------------
// XML, just enough of it
//
// ASSETMAP and CPL are small, regular, machine-written documents. Elements
// may carry a namespace prefix (`<cpl:Reel>`), so every lookup allows one.
// ---------------------------------------------------------------------------

/** Every `<name>…</name>` body in `xml`, namespace prefix or not. */
function elements(xml, name) {
  const re = new RegExp('<(?:[\\w.-]+:)?' + name + '(?:\\s[^>]*)?>([\\s\\S]*?)</(?:[\\w.-]+:)?' + name + '\\s*>', 'g');
  const out = [];
  let m;
  while ((m = re.exec(xml))) out.push(m[1]);
  return out;
}

function unescapeXml(s) {
  return s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'").replace(/&amp;/g, '&');
}

/** Text of the first `<name>` in `xml`, or null. */
function text(xml, name) {
  const all = elements(xml, name);
  return all.length ? unescapeXml(all[0].replace(/<[^>]*>/g, '').trim()) : null;
}

/** `urn:uuid:XXXX` → bare lower-case uuid. */
function uuid(s) {
  return s ? s.trim().toLowerCase().replace(/^urn:uuid:/, '') : null;
}

function readXml(filePath) {
  let s = fs.readFileSync(filePath, 'utf8');
  if (s.charCodeAt(0) === 0xFEFF) s = s.slice(1);
  return s;
}

/** First few KB of a file, to tell what kind of XML it is without reading it all. */
function head(filePath, bytes = 4096) {
  let fd;
  try {
    fd = fs.openSync(filePath, 'r');
    const buf = Buffer.alloc(bytes);
    const n = fs.readSync(fd, buf, 0, bytes, 0);
    return buf.toString('utf8', 0, n);
  } catch (_) {
    return '';
  } finally {
    if (fd !== undefined) { try { fs.closeSync(fd); } catch (_) { /* ignore */ } }
  }
}

function isCplFile(filePath) {
  return /<(?:[\w.-]+:)?CompositionPlaylist[\s>]/.test(head(filePath));
}

// ---------------------------------------------------------------------------
// Finding the package
// ---------------------------------------------------------------------------

/** Path of the ASSETMAP in `dir` — Interop names it ASSETMAP, SMPTE ASSETMAP.xml. */
function findAssetMap(dir) {
  let names;
  try { names = fs.readdirSync(dir); } catch (_) { return null; }
  const hit = names.find((n) => /^assetmap(\.xml)?$/i.test(n));
  return hit ? path.join(dir, hit) : null;
}

/**
 * uuid → absolute path, for every asset the ASSETMAP lists.
 * A Path may be relative, or a file:// URL (some Interop packages).
 */
function readAssetMap(assetMapPath) {
  const dir = path.dirname(assetMapPath);
  const xml = readXml(assetMapPath);
  const assets = new Map();
  for (const asset of elements(xml, 'Asset')) {
    const id = uuid(text(asset, 'Id'));
    let p = text(asset, 'Path');
    if (!id || !p) continue;
    p = p.replace(/^file:\/*/i, '');
    try { p = decodeURIComponent(p); } catch (_) { /* a literal % in a name */ }
    assets.set(id, path.resolve(dir, p));
  }
  return assets;
}

/**
 * Work out whether `inputPath` belongs to a DCP, and which compositions that
 * DCP holds.
 *
 * @returns {{dir:string, cpls:{path:string,title:string}[], preferred:string}|null}
 *   null when this is not a DCP — an ordinary .mxf or .xml falls through to
 *   the normal open path. `preferred` is the CPL to open when the caller has
 *   no reason to ask: the one that was picked, or the one that uses the
 *   picked track file, else the first.
 */
function resolve(inputPath) {
  let stat;
  try { stat = fs.statSync(inputPath); } catch (_) { return null; }

  let dir;
  let picked = null;
  if (stat.isDirectory()) {
    dir = inputPath;
    if (!findAssetMap(dir)) {
      // The folder ABOVE the package is an easy thing to pick by mistake.
      let subs = [];
      try {
        subs = fs.readdirSync(dir, { withFileTypes: true })
          .filter((e) => e.isDirectory()).map((e) => path.join(dir, e.name));
      } catch (_) { /* unreadable */ }
      const withMap = subs.filter((d) => findAssetMap(d));
      if (withMap.length !== 1) return null;
      dir = withMap[0];
    }
  } else {
    const ext = path.extname(inputPath).toLowerCase();
    const base = path.basename(inputPath);
    if (ext !== '.xml' && ext !== '.mxf' && !/^assetmap$/i.test(base)) return null;
    dir = path.dirname(inputPath);
    picked = path.resolve(inputPath);
  }

  const assetMapPath = findAssetMap(dir);
  if (!assetMapPath) return null;

  let assets;
  try { assets = readAssetMap(assetMapPath); } catch (_) { return null; }

  const cpls = [];
  for (const p of assets.values()) {
    if (path.extname(p).toLowerCase() !== '.xml') continue;
    if (!fs.existsSync(p) || !isCplFile(p)) continue;
    let title = null;
    try {
      const xml = readXml(p);
      title = text(xml, 'ContentTitleText') || text(xml, 'AnnotationText');
    } catch (_) { /* listed anyway, by filename */ }
    cpls.push({ path: p, title: title || path.basename(p) });
  }
  if (!cpls.length) return null;

  let preferred = cpls[0].path;
  if (picked) {
    const same = (a, b) => path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();
    const direct = cpls.find((c) => same(c.path, picked));
    if (direct) {
      preferred = direct.path;
    } else if (path.extname(picked).toLowerCase() === '.mxf') {
      // A track file: open the composition that plays it. An .mxf that no
      // CPL here refers to is just an MXF that happens to sit in the folder.
      const user = cpls.find((c) => {
        try {
          return parseCpl(c.path, assets).reels.some((r) =>
            (r.picture && r.picture.path && same(r.picture.path, picked)) ||
            (r.sound && r.sound.path && same(r.sound.path, picked)));
        } catch (_) { return false; }
      });
      if (!user) return null;
      preferred = user.path;
    }
  }

  return { dir, cpls, preferred };
}

// ---------------------------------------------------------------------------
// Version files (VF) and the package they borrow from (OV)
//
// A VF carries only what it changes — a new sound mix, say — and its CPL names
// the rest by UUID: track files that live in the original version's folder and
// are in THAT package's ASSETMAP, not this one's. A UUID is the whole identity
// of an asset, so finding the OV is a lookup, not a guess: any ASSETMAP that
// lists the id has the file.
//
// Two places are searched. Folders the operator has pointed at (remembered per
// composition, across launches), then the folders beside the VF, which is
// where an OV usually sits when both were delivered together.
// ---------------------------------------------------------------------------

// Content keys already unwrapped this session, by CPL uuid. Kept here and not
// on the composition object, because that object is sent to the renderer.
const contentKeys = new Map();

let linksFile = null;          // userData/dcp-links.json, once configure() is called
let links = {};                // CPL uuid → folders holding the track files it borrows

/** Tell this module where it may keep state. Called once, by main, at startup. */
function configure(opts) {
  kdm.configure(opts);
  contentKeys.clear();
  if (!opts || !opts.stateDir) return;
  linksFile = path.join(opts.stateDir, 'dcp-links.json');
  try {
    const saved = JSON.parse(fs.readFileSync(linksFile, 'utf8'));
    if (saved && typeof saved === 'object') links = saved;
  } catch (_) { /* none yet */ }
}

function saveLinks() {
  if (!linksFile) return;
  try { fs.writeFileSync(linksFile, JSON.stringify(links, null, 2)); } catch (_) { /* not fatal */ }
}

/** `dir` if it is a package, else the packages directly inside it. */
function packagesIn(dir) {
  if (findAssetMap(dir)) return [dir];
  try {
    return fs.readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isDirectory()).map((e) => path.join(dir, e.name))
      .filter((d) => findAssetMap(d));
  } catch (_) {
    return [];
  }
}

/** Every track of a composition, with where it sits, for messages. */
function tracksOf(comp) {
  const out = [];
  for (const [i, r] of comp.reels.entries()) {
    for (const what of ['picture', 'sound']) {
      if (r[what]) out.push({ reel: i + 1, what, track: r[what] });
    }
  }
  return out;
}

/** The tracks whose file cannot be found. */
function missingTracks(comp) {
  return tracksOf(comp).filter((t) => !t.track.path || !fs.existsSync(t.track.path));
}

/**
 * Fill in the track files this composition borrows from other packages.
 * Marks each one `foreign` and lists the folders used in `comp.ovDirs`.
 */
function resolveForeign(comp, extraDirs) {
  comp.ovDirs = [];
  let missing = tracksOf(comp).filter((t) => !t.track.path);
  comp.isVf = missing.length > 0;
  if (!missing.length) return;

  const same = (a, b) => path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();
  const candidates = [];
  const add = (d) => { if (!same(d, comp.dir) && !candidates.some((c) => same(c, d))) candidates.push(d); };
  for (const d of extraDirs || []) packagesIn(d).forEach(add);
  for (const d of (comp.id && links[comp.id]) || []) packagesIn(d).forEach(add);
  packagesIn(path.dirname(comp.dir)).forEach(add);

  for (const dir of candidates) {
    let map;
    try { map = readAssetMap(findAssetMap(dir)); } catch (_) { continue; }
    let used = false;
    for (const t of missing) {
      const p = map.get(t.track.id);
      if (p && fs.existsSync(p)) { t.track.path = p; t.track.foreign = true; used = true; }
    }
    if (used) comp.ovDirs.push(dir);
    missing = missing.filter((t) => !t.track.path);
    if (!missing.length) break;
  }
}

/**
 * Point a version file at the folder that holds its original version.
 *
 * @param {string} cplPath  The VF's CPL.
 * @param {string} folder   The OV package, or a folder that contains it.
 * @returns {{found:number, stillMissing:number}|{error:string}}
 */
function linkOv(cplPath, folder) {
  let before;
  try { before = missingTracks(parseCpl(cplPath)).length; } catch (err) { return { error: err.message }; }
  if (!packagesIn(folder).length) {
    return { error: 'That folder is not a DCP and does not contain one:\n' + folder };
  }
  const comp = parseCpl(cplPath, null, [folder]);
  const after = missingTracks(comp).length;
  if (after >= before) {
    return { error: 'That package does not hold the track files this version file needs:\n' + folder };
  }
  if (comp.id) {
    const list = links[comp.id] || [];
    if (!list.includes(folder)) list.push(folder);
    links[comp.id] = list;
    saveLinks();
  }
  return { found: before - after, stillMissing: after };
}

// ---------------------------------------------------------------------------
// The composition
// ---------------------------------------------------------------------------

/** One reel asset (`<MainPicture>`, `<MainSound>` …) as numbers and a path. */
function parseTrack(xml, assets) {
  const id = uuid(text(xml, 'Id'));
  const rate = (text(xml, 'EditRate') || '24 1').trim().split(/\s+/).map(Number);
  const num = rate[0] > 0 ? rate[0] : 24;
  const den = rate[1] > 0 ? rate[1] : 1;
  const intrinsic = parseInt(text(xml, 'IntrinsicDuration') || '0', 10) || 0;
  const entry = parseInt(text(xml, 'EntryPoint') || '0', 10) || 0;
  const durText = text(xml, 'Duration');
  const duration = durText !== null ? (parseInt(durText, 10) || 0) : Math.max(0, intrinsic - entry);
  return {
    id,
    path: (id && assets.get(id)) || null,
    rateNum: num,
    rateDen: den,
    entry,
    duration,
    keyId: uuid(text(xml, 'KeyId')),
    encrypted: !!text(xml, 'KeyId'),
  };
}

/**
 * Parse a CPL into its reels.
 *
 * @param {string} cplPath
 * @param {Map<string,string>} [assets]  From readAssetMap(); read here if omitted.
 * @param {string[]} [extraDirs]  More folders to look in for borrowed track files.
 */
function parseCpl(cplPath, assets, extraDirs) {
  const lookAbroad = !assets;      // resolve() passes its own map and wants only this package
  if (!assets) {
    const am = findAssetMap(path.dirname(cplPath));
    if (!am) throw new Error('No ASSETMAP beside this CPL — the folder is not a complete DCP.');
    assets = readAssetMap(am);
  }
  const xml = readXml(cplPath);
  if (!/<(?:[\w.-]+:)?CompositionPlaylist[\s>]/.test(xml)) {
    throw new Error('Not a Composition Playlist: ' + path.basename(cplPath));
  }

  const comp = {
    cplPath,
    dir: path.dirname(cplPath),
    id: uuid(text(xml.replace(/<(?:[\w.-]+:)?ReelList[\s\S]*$/, ''), 'Id')),
    title: text(xml, 'ContentTitleText') || text(xml, 'AnnotationText') || path.basename(cplPath),
    kind: text(xml, 'ContentKind'),
    standard: /smpte-ra\.org/i.test(xml) ? 'SMPTE' : 'Interop',
    encrypted: false,
    stereoscopic: false,
    hasSubtitles: false,
    reels: [],
  };

  for (const reelXml of elements(xml, 'Reel')) {
    const reel = { picture: null, sound: null };
    const pic = elements(reelXml, 'MainPicture')[0];
    const pic3d = elements(reelXml, 'MainStereoscopicPicture')[0];
    const snd = elements(reelXml, 'MainSound')[0];
    if (pic3d) comp.stereoscopic = true;
    if (pic || pic3d) reel.picture = parseTrack(pic || pic3d, assets);
    if (snd) reel.sound = parseTrack(snd, assets);
    if (elements(reelXml, 'MainSubtitle').length || elements(reelXml, 'ClosedCaption').length ||
        elements(reelXml, 'MainClosedCaption').length) comp.hasSubtitles = true;
    if ((reel.picture && reel.picture.encrypted) || (reel.sound && reel.sound.encrypted)) comp.encrypted = true;
    if (reel.picture) comp.reels.push(reel);
  }

  if (!comp.reels.length) throw new Error('This CPL has no picture reels.');
  if (lookAbroad) resolveForeign(comp, extraDirs);

  const first = comp.reels[0].picture;
  comp.rateNum = first.rateNum;
  comp.rateDen = first.rateDen;
  comp.fps = first.rateNum / first.rateDen;
  comp.totalFrames = comp.reels.reduce((n, r) => n + r.picture.duration, 0);
  comp.duration = comp.totalFrames / comp.fps;
  return comp;
}

/**
 * Why this composition cannot be played, or null when it can. Said in the
 * words an operator needs, because this is what the alert shows.
 */
function playableError(comp) {
  if (comp.stereoscopic) {
    return 'This is a stereoscopic (3D) DCP, which MaidenPlayer does not play yet.';
  }
  const missing = missingTracks(comp).map((m) => 'reel ' + m.reel + ' ' + m.what + ' (' +
    (m.track.path ? path.basename(m.track.path) : m.track.id + ', not in this package') + ')');
  if (missing.length) {
    return 'This DCP is missing track files:\n  ' + missing.slice(0, 6).join('\n  ') +
           (missing.length > 6 ? '\n  … and ' + (missing.length - 6) + ' more' : '') +
           (needsOv(comp)
             ? '\n\nIt is a version file (VF): those track files live in the original version (OV) ' +
               'package. Open it again and point MaidenPlayer at the OV folder.'
             : '');
  }
  if (comp.encrypted) {
    const got = keysOf(comp);
    if (got.error) {
      return got.error + '\n\nAn encrypted DCP plays with a KDM made for this player\'s certificate. ' +
             'Load one with File ▸ Load KDM…, or put it in the DCP\'s folder.';
    }
  }
  return null;
}

/** Is what stops this composition playing an OV that has not been found? */
function needsOv(comp) {
  return !comp.stereoscopic && missingTracks(comp).some((m) => !m.track.path);
}

/** Is what stops it a missing (or unusable) KDM? Only asked once the track files are all there. */
function needsKdm(comp) {
  return !comp.stereoscopic && comp.encrypted && !missingTracks(comp).length && !!keysOf(comp).error;
}

/** The content keys of an encrypted composition: { keys } or { error }. */
function keysOf(comp) {
  if (!comp.encrypted) return { keys: new Map() };
  const held = comp.id && contentKeys.get(comp.id);
  if (held) return { keys: held };
  const got = kdm.keysFor(comp);
  if (got.keys && comp.id) contentKeys.set(comp.id, got.keys);
  return got;
}

/** Take in a KDM file; see dcp-kdm.js. Keys unwrapped earlier are looked up afresh. */
function loadKdm(filePath) {
  const result = kdm.loadKdm(filePath);
  if (!result.error) contentKeys.clear();
  return result;
}

// ---------------------------------------------------------------------------
// Probe
// ---------------------------------------------------------------------------

/**
 * Probe a composition. The result has the same shape as
 * transcoder.probeFile()'s, so the renderer and the stream decoder need no
 * special cases beyond `isDcp`.
 */
async function probe(cplPath) {
  const comp = parseCpl(cplPath);
  const problem = playableError(comp);
  if (problem) {
    return { error: problem, isDcp: true, needsOv: needsOv(comp), needsKdm: needsKdm(comp), title: comp.title, cplId: comp.id };
  }

  const pic = await transcoder.probeFile(comp.reels[0].picture.path);
  if (!pic.codec) {
    return { error: 'The picture track file could not be read: ' + path.basename(comp.reels[0].picture.path), isDcp: true };
  }

  // Sound only counts when every reel has it: a composition that goes silent
  // for one reel would otherwise drift, because the sound of the reels after
  // it would be joined on early.
  const allSound = comp.reels.every((r) => r.sound);
  let snd = null;
  if (allSound) {
    try { snd = await transcoder.probeFile(comp.reels[0].sound.path); } catch (_) { snd = null; }
    if (snd && !snd.audioCodec) snd = null;
  }
  comp.hasSound = !!snd;
  comp.soundChannels = snd ? (snd.audioChannelsTotal || 0) : 0;

  const k = pic.width > 2048 || pic.height > 1080 ? '4K' : '2K';
  return {
    filePath: cplPath,
    isDcp: true,
    dcp: comp,
    codec: 'jpeg2000',
    codecFriendly: 'JPEG 2000 (DCP ' + k + ', ' + comp.standard + ')',
    codecProfile: pic.codecProfile,
    container: 'dcp',
    width: pic.width,
    height: pic.height,
    fps: comp.fps,
    duration: comp.duration,
    bitrate: pic.bitrate,
    audioCodec: snd ? snd.audioCodec : null,
    audioFriendly: snd ? snd.audioFriendly : null,
    audioDetails: snd ? snd.audioDetails : null,
    audioStreamCount: snd ? 1 : 0,
    // What the player is given to hear and meter — see soundFilter().
    audioChannelsTotal: snd ? outputChannels(comp.soundChannels) : 0,
    needsTranscode: true,
    transcodeReason: 'DCP',
    isProRes: false,
    isDNx: false,
    sourceTimecode: null,
    sourceTimecodeSeconds: 0,
  };
}

// ---------------------------------------------------------------------------
// ffmpeg inputs
// ---------------------------------------------------------------------------

/**
 * Channels handed to the player from a sound track file with `n`.
 *
 * A DCP sound file is 6, 8 or 16 channels wide and only the first six are
 * the 5.1 mix. 7 and 8 are HI and VI-N — the hearing-impaired dialogue boost
 * and the audio description — and past that sit sync and motion-data
 * signals. Passing all of it on would have the desktop fold narration and a
 * sync tone into what the operator hears, so the bed stops at 5.1.
 */
function outputChannels(n) {
  if (n >= 6) return 6;
  return Math.max(1, n | 0);
}

/** Filter that keeps the bed channels, in order, with no mixing. */
function soundFilter(comp) {
  const out = outputChannels(comp.soundChannels);
  if (comp.soundChannels === out && out !== 6) return null;
  const maps = Array.from({ length: out }, (_, i) => 'c' + i + '=c' + i).join('|');
  // DCP order is L R C LFE Ls Rs, which is ffmpeg's 5.1 order too.
  return 'pan=' + (out === 6 ? '5.1' : out + 'c') + '|' + maps;
}

/** A path as the concat script wants it: forward slashes, quotes escaped. */
function scriptPath(p) {
  return "'" + p.replace(/\\/g, '/').replace(/'/g, "'\\''") + "'";
}

/**
 * Write the concat scripts that play a composition from frame `startFrame`,
 * and return their paths.
 *
 * The seek is written INTO the script — reels before the position are left
 * out and the first one starts at a later `inpoint` — instead of being asked
 * of ffmpeg with `-ss`. The concat demuxer does not pass `-ss` down to the
 * MXF's index: it decodes and throws away every frame before the target, so
 * a seek a minute into a 2K reel took 18 s. The same position as an inpoint
 * takes 0.6 s, because that one IS an index seek. `outpoint` ends each track
 * file where the CPL says the reel does.
 *
 * Rewritten on every start; ffmpeg has read its copy by the time the next
 * seek replaces it.
 */
function writeScripts(comp, startFrame) {
  fs.mkdirSync(SCRIPT_DIR, { recursive: true });
  const key = crypto.createHash('sha1').update(comp.cplPath).digest('hex').slice(0, 16);

  let keys = new Map();
  if (comp.encrypted) {
    const got = keysOf(comp);
    if (got.error) throw new Error(got.error);
    keys = got.keys;
  }

  const build = (which) => {
    const lines = ['ffconcat version 1.0'];
    let reelStart = 0;                       // composition frame this reel begins on
    for (const r of comp.reels) {
      const reelFrames = r.picture.duration; // a reel is as long as its PICTURE
      const skip = Math.max(0, startFrame - reelStart);
      reelStart += reelFrames;
      if (skip >= reelFrames) continue;      // wholly before the seek position

      const t = r[which];
      const rate = t.rateNum / t.rateDen;
      const picRate = r.picture.rateNum / r.picture.rateDen;
      const entry = t.entry / rate;
      lines.push('file ' + scriptPath(t.path));
      // An encrypted track file: its AES key, for the MXF reader that opens it.
      if (t.keyId) lines.push('option cryptokey ' + keys.get(t.keyId));
      lines.push('inpoint ' + (entry + skip / picRate).toFixed(6));
      lines.push('outpoint ' + (entry + reelFrames / picRate).toFixed(6));
    }
    const p = path.join(SCRIPT_DIR, key + '-' + which + '.ffconcat');
    fs.writeFileSync(p, lines.join('\n') + '\n');
    return p;
  };

  // Encrypted sound does not go through ffmpeg's MXF reader — see pumpSound().
  const soundByScript = comp.hasSound && !soundIsEncrypted(comp);
  return { picture: build('picture'), sound: soundByScript ? build('sound') : null, secret: keys.size > 0, keys };
}

function soundIsEncrypted(comp) {
  return comp.reels.some((r) => r.sound && r.sound.keyId);
}

/**
 * Feed a composition's sound to ffmpeg as raw PCM, from frame `startFrame`.
 *
 * Used for encrypted packages only: ffmpeg decrypts their sound correctly but
 * mis-times it after a seek (dcp-mxf.js has the detail), so the frames are
 * read and decrypted here and written to a pipe ffmpeg treats as plain
 * 24-bit PCM. Reels are simply written one after another, which is all a
 * join is once the samples are raw.
 *
 * @returns {{sampleRate:number, channels:number, start:(out:import('stream').Writable)=>()=>void}}
 */
function pumpSound(comp, startFrame, keys) {
  const segments = [];
  let reelStart = 0;
  for (const r of comp.reels) {
    const reelFrames = r.picture.duration;
    const skip = Math.max(0, startFrame - reelStart);
    reelStart += reelFrames;
    if (skip >= reelFrames) continue;
    segments.push({
      path: r.sound.path,
      key: r.sound.keyId ? Buffer.from(keys.get(r.sound.keyId), 'hex') : null,
      from: r.sound.entry + skip,
      to: r.sound.entry + reelFrames,
    });
  }

  // The sample rate is not in the CPL. One frame of sound says it: its bytes
  // over (channels × 3 bytes) is the samples in one frame.
  const channels = Math.max(1, comp.soundChannels | 0);
  const probeFile = new TrackFile(segments[0].path);
  let frameBytes;
  try { frameBytes = probeFile.frame(segments[0].from, segments[0].key).length; } finally { probeFile.close(); }
  const sampleRate = Math.round(frameBytes / (channels * 3) * comp.fps);

  const start = (out) => {
    let stopped = false;
    let file = null;
    const settle = () => new Promise((resolve) => {
      const done = () => { out.off('drain', done); out.off('close', done); out.off('error', done); resolve(); };
      out.once('drain', done); out.once('close', done); out.once('error', done);
    });
    out.on('error', () => { stopped = true; });          // ffmpeg went away: not news
    (async () => {
      try {
        for (const seg of segments) {
          if (stopped) break;
          file = new TrackFile(seg.path);
          for (let f = seg.from; f < seg.to && !stopped;) {
            const parts = [];
            for (let i = 0; i < 12 && f < seg.to; i++, f++) parts.push(file.frame(f, seg.key));
            if (stopped) break;
            if (!out.write(Buffer.concat(parts))) await settle();
            else await new Promise(setImmediate);
          }
          file.close();
          file = null;
        }
      } catch (err) {
        console.error('[DCP] sound read stopped:', err.message);
      }
      if (file) file.close();
      if (!stopped) { try { out.end(); } catch (_) { /* closed */ } }
    })();
    return () => {
      stopped = true;
      try { out.destroy(); } catch (_) { /* closed */ }
    };
  };
  return { sampleRate, channels, start };
}

/**
 * The ffmpeg inputs that play a composition from `seekTime`.
 *
 * Input 0 is always the picture; input 1, when present, the sound. Both
 * begin at t=0 on the frame nearest `seekTime`.
 *
 * @param {object} comp     probe().dcp
 * @param {number} seekTime Seconds into the composition.
 * @param {number} lowres   JPEG 2000 resolution levels to skip: 0 full, 1 half, 2 quarter.
 *                          A wavelet codec can stop early, which is what makes
 *                          this cheap — half size is about 3× the frame rate.
 * @returns {{args:string[], hasSound:boolean, soundFilter:string|null}}
 */
function inputArgs(comp, seekTime, lowres) {
  // Whole frames, so picture and sound are cut at the same instant. Never
  // past the last frame: an empty script is not a stream.
  const startFrame = Math.min(Math.max(0, comp.totalFrames - 1),
    seekTime > 0 ? Math.round(seekTime * comp.fps) : 0);
  const scripts = writeScripts(comp, startFrame);
  const args = [];

  if (lowres > 0) args.push('-lowres', String(lowres));
  args.push('-f', 'concat', '-safe', '0', '-i', scripts.picture);
  if (scripts.sound) args.push('-f', 'concat', '-safe', '0', '-i', scripts.sound);

  let pump = null;
  if (comp.hasSound && !scripts.sound) {
    pump = pumpSound(comp, startFrame, scripts.keys);
    args.push('-thread_queue_size', '512', '-f', 's24le', '-ar', String(pump.sampleRate),
      '-ac', String(pump.channels), '-i', 'pipe:3');
  }

  return {
    args,
    hasSound: !!comp.hasSound,
    soundFilter: comp.hasSound ? soundFilter(comp) : null,
    // When set, the caller opens ffmpeg with a fourth pipe and calls this with
    // it; the function it returns stops the feed.
    soundPump: pump ? pump.start : null,
    // Scripts that carry content keys. ffmpeg reads a script once, when it
    // opens it, so the caller deletes these as soon as output starts flowing.
    secretFiles: scripts.secret ? [scripts.picture, scripts.sound].filter(Boolean) : [],
  };
}

/** Delete the key-bearing scripts of a started stream. */
function forgetSecrets(plan) {
  for (const p of (plan && plan.secretFiles) || []) {
    try { fs.unlinkSync(p); } catch (_) { /* already gone */ }
  }
}

/**
 * Resolution levels to skip when the operator has not said. 4K is decoded as
 * 2K — the desktop picture is an H.264 review proxy either way, and full 4K
 * JPEG 2000 is far from realtime in software. 2K starts at full size; the
 * stream decoder steps it down if this machine cannot keep up.
 */
function defaultLowres(probeInfo) {
  return (probeInfo.width > 2048 || probeInfo.height > 1080) ? 1 : 0;
}

/** The deepest reduction worth offering: below this the picture is a thumbnail. */
function maxLowres(probeInfo) {
  return (probeInfo.width > 2048 || probeInfo.height > 1080) ? 3 : 2;
}

function isDcpProbe(probeInfo) {
  return !!(probeInfo && probeInfo.isDcp && probeInfo.dcp);
}

/** Remove the concat scripts. Called at quit. */
function cleanup() {
  try { fs.rmSync(SCRIPT_DIR, { recursive: true, force: true }); } catch (_) { /* ignore */ }
}

module.exports = {
  configure,
  linkOv,
  loadKdm,
  exportCertificate: (p) => kdm.exportCertificate(p),
  forgetSecrets,
  missingTracks,
  resolve,
  parseCpl,
  playableError,
  probe,
  inputArgs,
  defaultLowres,
  maxLowres,
  isDcpProbe,
  isCplFile,
  cleanup,
};
