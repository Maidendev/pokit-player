/**
 * MaidenPlayer — KDMs, and the certificate they are made out to
 *
 * An encrypted DCP's picture and sound are AES-128 encrypted, one key per
 * track file. The keys never travel with the package. They come in a KDM
 * (Key Delivery Message, SMPTE ST 430-1): an XML in which each content key
 * is RSA-encrypted to ONE recipient's public key, together with the window
 * of dates in which that recipient may use it.
 *
 * So before anyone can send this player a KDM, the player needs an identity
 * to send it to:
 *
 *   identity()           this installation's certificate chain and private
 *                        key, made on first use (SMPTE ST 430-2 profile:
 *                        RSA 2048, SHA-256, root → intermediate → leaf).
 *   exportCertificate()  the leaf certificate and the chain as PEM, to hand
 *                        to whoever issues the KDM.
 *   loadKdm(file)        take in a KDM: check it is ours and keep a copy.
 *   keysFor(comp)        the content keys for a composition, from the KDMs
 *                        loaded earlier or lying beside the package.
 *
 * What this is NOT: a secure media block. The private key lives in software
 * (protected by the OS keychain where there is one) and a determined person
 * can extract it. It is the same trade every software DCP player makes, and
 * it is why studios issue theatrical KDMs to certified hardware only.
 *
 * Not checked: the KDM's XML signature, and the per-frame integrity codes
 * (MIC) inside the track files.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

let stateDir = null;
let protect = null;      // (string) → Buffer, OS keychain encryption; null when unavailable
let unprotect = null;    // (Buffer) → string
let cachedIdentity = null;

/** Where state is kept, and how to protect a secret at rest. Called once by main. */
function configure(opts) {
  stateDir = (opts && opts.stateDir) || null;
  protect = (opts && opts.protect) || null;
  unprotect = (opts && opts.unprotect) || null;
  cachedIdentity = null;
}

// ---------------------------------------------------------------------------
// DER, just enough to write a certificate
// ---------------------------------------------------------------------------

function tlv(tag, content) {
  const len = content.length;
  let head;
  if (len < 0x80) head = Buffer.from([tag, len]);
  else if (len < 0x100) head = Buffer.from([tag, 0x81, len]);
  else if (len < 0x10000) head = Buffer.from([tag, 0x82, len >> 8, len & 0xff]);
  else head = Buffer.from([tag, 0x83, len >> 16, (len >> 8) & 0xff, len & 0xff]);
  return Buffer.concat([head, content]);
}
const seq = (...parts) => tlv(0x30, Buffer.concat(parts));
const set = (...parts) => tlv(0x31, Buffer.concat(parts));
const octets = (buf) => tlv(0x04, buf);
const bool = (v) => tlv(0x01, Buffer.from([v ? 0xff : 0x00]));
const printable = (s) => tlv(0x13, Buffer.from(s, 'latin1'));
const bitString = (buf, unused = 0) => tlv(0x03, Buffer.concat([Buffer.from([unused]), buf]));
const explicit = (n, content) => tlv(0xa0 | n, content);

/** The content bytes of a non-negative INTEGER, from big-endian bytes or a small number. */
function integerBytes(v) {
  let buf = Buffer.isBuffer(v) ? v : Buffer.from([v]);
  while (buf.length > 1 && buf[0] === 0 && !(buf[1] & 0x80)) buf = buf.subarray(1);
  if (buf[0] & 0x80) buf = Buffer.concat([Buffer.from([0]), buf]);
  return buf;
}
const integer = (v) => tlv(0x02, integerBytes(v));

function oid(dotted) {
  const n = dotted.split('.').map(Number);
  const bytes = [n[0] * 40 + n[1]];
  for (const v of n.slice(2)) {
    const stack = [v & 0x7f];
    for (let r = v >>> 7; r > 0; r >>>= 7) stack.unshift((r & 0x7f) | 0x80);
    bytes.push(...stack);
  }
  return tlv(0x06, Buffer.from(bytes));
}

function utcTime(date) {
  const p = (x) => String(x).padStart(2, '0');
  return tlv(0x17, Buffer.from(
    p(date.getUTCFullYear() % 100) + p(date.getUTCMonth() + 1) + p(date.getUTCDate()) +
    p(date.getUTCHours()) + p(date.getUTCMinutes()) + p(date.getUTCSeconds()) + 'Z', 'latin1'));
}

const OID = {
  o: '2.5.4.10', ou: '2.5.4.11', cn: '2.5.4.3', dnQualifier: '2.5.4.46',
  sha256Rsa: '1.2.840.113549.1.1.11',
  basicConstraints: '2.5.29.19', keyUsage: '2.5.29.15', ski: '2.5.29.14', aki: '2.5.29.35',
};

const ORGANIZATION = 'Maiden Media Solutions Inc.';
const UNIT = 'MaidenPlayer';

// ---------------------------------------------------------------------------
// The certificate chain
// ---------------------------------------------------------------------------

/** SHA-1 of the RSA public key itself (the PKCS#1 structure), as ST 430-2 thumbprints it. */
function publicKeyHash(publicKey) {
  return crypto.createHash('sha1').update(publicKey.export({ type: 'pkcs1', format: 'der' })).digest();
}

/** O, OU, CN, dnQualifier — the four attributes ST 430-2 asks for, in its order. */
function distinguishedName(cn, publicKey) {
  const rdn = (type, value) => set(seq(oid(type), printable(value)));
  return seq(
    rdn(OID.o, ORGANIZATION),
    rdn(OID.ou, UNIT),
    rdn(OID.cn, cn),
    rdn(OID.dnQualifier, publicKeyHash(publicKey).toString('base64')));
}

/**
 * One X.509 v3 certificate, DER.
 *
 * @param {object} subject  { cn, publicKey }
 * @param {object} issuer   { cn, publicKey, privateKey, serial, signedBy }  (itself, for the root)
 * @param {object} opts     { serial:Buffer, ca:boolean, pathLen:number, from:Date, to:Date }
 */
function makeCertificate(subject, issuer, opts) {
  const sigAlg = seq(oid(OID.sha256Rsa), tlv(0x05, Buffer.alloc(0)));
  const issuerName = distinguishedName(issuer.cn, issuer.publicKey);
  const ext = (id, critical, value) => seq(oid(id), ...(critical ? [bool(true)] : []), octets(value));

  const extensions = seq(
    ext(OID.basicConstraints, true, opts.ca ? seq(bool(true), integer(opts.pathLen)) : seq()),
    // keyCertSign for an authority; digitalSignature + keyEncipherment for the leaf.
    ext(OID.keyUsage, true, opts.ca ? bitString(Buffer.from([0x04]), 2) : bitString(Buffer.from([0xa0]), 5)),
    ext(OID.ski, false, octets(publicKeyHash(subject.publicKey))),
    // Names the issuer's CERTIFICATE three ways: its key, and the issuer name
    // and serial number printed on it — so the name here is the issuer's own
    // issuer, not the issuer.
    ext(OID.aki, false, seq(
      tlv(0x80, publicKeyHash(issuer.publicKey)),
      tlv(0xa1, tlv(0xa4, distinguishedName(issuer.signedBy.cn, issuer.signedBy.publicKey))),
      tlv(0x82, integerBytes(issuer.serial)))));

  const tbs = seq(
    explicit(0, integer(2)),                                  // v3
    integer(opts.serial),
    sigAlg,
    issuerName,
    seq(utcTime(opts.from), utcTime(opts.to)),
    distinguishedName(subject.cn, subject.publicKey),
    subject.publicKey.export({ type: 'spki', format: 'der' }),
    explicit(3, extensions));

  const signature = crypto.sign('sha256', tbs, issuer.privateKey);
  return seq(tbs, sigAlg, bitString(signature));
}

function pem(der) {
  return '-----BEGIN CERTIFICATE-----\n' + der.toString('base64').match(/.{1,64}/g).join('\n') +
         '\n-----END CERTIFICATE-----\n';
}

/** Make a new three-certificate chain. The two authority keys are thrown away once they have signed. */
function generateIdentity() {
  const pair = () => crypto.generateKeyPairSync('rsa', { modulusLength: 2048, publicExponent: 65537 });
  const serial = () => { const b = crypto.randomBytes(8); b[0] &= 0x7f; b[0] |= 0x40; return b; };
  const tag = crypto.randomBytes(4).toString('hex');
  const from = new Date(Date.now() - 24 * 3600 * 1000);
  const to = new Date(Date.UTC(from.getUTCFullYear() + 20, from.getUTCMonth(), from.getUTCDate()));

  const root = Object.assign(pair(), { cn: '.' + UNIT + '.ROOT.' + tag, serial: serial() });
  const mid = Object.assign(pair(), { cn: '.' + UNIT + '.INTERMEDIATE.' + tag, serial: serial() });
  const leaf = Object.assign(pair(), { cn: 'CS.' + UNIT + '.LEAF.' + tag, serial: serial() });
  root.signedBy = root;
  mid.signedBy = root;

  const rootCert = makeCertificate(root, root, { serial: root.serial, ca: true, pathLen: 3, from, to });
  const midCert = makeCertificate(mid, root, { serial: mid.serial, ca: true, pathLen: 2, from, to });
  const leafCert = makeCertificate(leaf, mid, { serial: leaf.serial, ca: false, from, to });

  return {
    version: 1,
    created: new Date().toISOString(),
    leaf: { cert: pem(leafCert), key: leaf.privateKey.export({ type: 'pkcs8', format: 'pem' }) },
    chain: [pem(leafCert), pem(midCert), pem(rootCert)],
  };
}

function identityFile() {
  if (!stateDir) throw new Error('KDM support is not configured (no state folder).');
  return path.join(stateDir, 'dcp-identity.json');
}

/**
 * This installation's identity, made and saved the first time it is asked for.
 * @returns {{leafCert:string, chain:string[], privateKey:crypto.KeyObject, subject:string, serial:string, created:string}}
 */
function identity() {
  if (cachedIdentity) return cachedIdentity;
  const file = identityFile();
  let saved = null;
  try { saved = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_) { saved = null; }

  let keyPem = null;
  if (saved && saved.leaf && saved.leaf.cert && saved.leaf.key) {
    try {
      keyPem = saved.leaf.protected ? unprotect(Buffer.from(saved.leaf.key, 'base64')) : saved.leaf.key;
    } catch (err) {
      // The keychain will not give the key back (another user, a moved profile).
      // Do NOT quietly make a new identity over it: every KDM issued so far is
      // for the old one, and the operator needs to know why they stopped working.
      throw new Error('The player certificate\'s private key could not be unlocked on this machine (' +
        err.message + '). KDMs made for it cannot be used here.');
    }
  } else {
    const fresh = generateIdentity();
    keyPem = fresh.leaf.key;
    saved = fresh;
    const onDisk = JSON.parse(JSON.stringify(fresh));
    if (protect) {
      try {
        onDisk.leaf.key = protect(keyPem).toString('base64');
        onDisk.leaf.protected = true;
      } catch (_) { /* no keychain: stored as PEM, readable only by this user account's files */ }
    }
    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(file, JSON.stringify(onDisk, null, 2), { mode: 0o600 });
  }

  const x509 = new crypto.X509Certificate(saved.leaf.cert);
  cachedIdentity = {
    leafCert: saved.leaf.cert,
    chain: saved.chain,
    privateKey: crypto.createPrivateKey(keyPem),
    subject: x509.subject.replace(/\n/g, ', '),
    serial: BigInt('0x' + x509.serialNumber).toString(10),
    thumbprint: publicKeyHash(x509.publicKey).toString('base64'),
    created: saved.created,
  };
  return cachedIdentity;
}

/**
 * Write the certificate a KDM issuer asks for. `filePath` gets the leaf (the
 * "recipient certificate"); a second file beside it gets the whole chain, for
 * the issuers that want that instead.
 */
function exportCertificate(filePath) {
  const id = identity();
  fs.writeFileSync(filePath, id.leafCert);
  const chainPath = filePath.replace(/(\.[^.\\/]+)?$/, '-chain$1');
  fs.writeFileSync(chainPath, id.chain.join(''));
  return { leaf: filePath, chain: chainPath, subject: id.subject, thumbprint: id.thumbprint };
}

// ---------------------------------------------------------------------------
// Reading a KDM
// ---------------------------------------------------------------------------

function elements(xml, name) {
  const re = new RegExp('<(?:[\\w.-]+:)?' + name + '(?:\\s[^>]*)?>([\\s\\S]*?)</(?:[\\w.-]+:)?' + name + '\\s*>', 'g');
  const out = [];
  let m;
  while ((m = re.exec(xml))) out.push(m[1]);
  return out;
}
function text(xml, name) {
  const all = elements(xml, name);
  return all.length ? all[0].replace(/<[^>]*>/g, '').trim() : null;
}
const bareUuid = (s) => (s ? s.trim().toLowerCase().replace(/^urn:uuid:/, '') : null);
const uuidOf = (buf) => {
  const h = buf.toString('hex');
  return [h.slice(0, 8), h.slice(8, 12), h.slice(12, 16), h.slice(16, 20), h.slice(20)].join('-');
};

function isKdm(xml) {
  return /<(?:[\w.-]+:)?DCinemaSecurityMessage[\s>]/.test(xml) && /KDMRequiredExtensions/.test(xml);
}

/** The public part of a KDM: what it is for, who it is for, and when. No key needed. */
function readKdm(xml) {
  if (!isKdm(xml)) throw new Error('This file is not a KDM.');
  return {
    id: bareUuid(text(xml, 'MessageId')),
    cplId: bareUuid(text(xml, 'CompositionPlaylistId')),
    title: text(xml, 'ContentTitleText'),
    annotation: text(xml, 'AnnotationText'),
    notBefore: text(xml, 'ContentKeysNotValidBefore'),
    notAfter: text(xml, 'ContentKeysNotValidAfter'),
    recipientSerial: text(elements(xml, 'Recipient')[0] || '', 'X509SerialNumber'),
    recipientSubject: text(elements(xml, 'Recipient')[0] || '', 'X509SubjectName'),
    cipherValues: elements(xml, 'EncryptedKey').map((e) => (text(e, 'CipherValue') || '').replace(/\s+/g, '')),
  };
}

/**
 * Unwrap a KDM's content keys with this player's private key.
 *
 * Each key arrives as one RSA-OAEP block: 138 bytes in a SMPTE KDM (structure
 * id, signer thumbprint, CPL id, key type, key id, the two dates, the key) and
 * 134 in an Interop one, which has no key type.
 *
 * @returns {Map<string,string>}  key id → AES key, hex. Empty when the KDM was
 *   made for a different certificate — RSA simply fails to decrypt.
 */
function unwrapKeys(kdm, privateKey) {
  const keys = new Map();
  for (const b64 of kdm.cipherValues) {
    let plain;
    try {
      plain = crypto.privateDecrypt(
        { key: privateKey, padding: crypto.constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha1' },
        Buffer.from(b64, 'base64'));
    } catch (_) {
      continue;
    }
    let o;
    if (plain.length === 138) o = 56;          // … CPL id, key TYPE (4), key id
    else if (plain.length === 134) o = 52;     // … CPL id, key id
    else continue;
    const cplId = uuidOf(plain.subarray(36, 52));
    if (kdm.cplId && cplId !== kdm.cplId) continue;
    keys.set(uuidOf(plain.subarray(o, o + 16)), plain.subarray(plain.length - 16).toString('hex'));
  }
  return keys;
}

/** Why a KDM cannot be used right now, or null. */
function windowProblem(kdm, now = new Date()) {
  const from = kdm.notBefore ? new Date(kdm.notBefore) : null;
  const to = kdm.notAfter ? new Date(kdm.notAfter) : null;
  const show = (d) => d.toLocaleString();
  if (from && !isNaN(from) && now < from) return 'This KDM is not valid yet. It opens ' + show(from) + '.';
  if (to && !isNaN(to) && now > to) return 'This KDM expired ' + show(to) + '.';
  return null;
}

function kdmDir() {
  return stateDir ? path.join(stateDir, 'kdm') : null;
}

/**
 * Take in a KDM file. It is kept (still encrypted to this player) so the DCP
 * opens next time without asking.
 *
 * @returns {{cplId, title, notBefore, notAfter, keys:number, warning:string|null}|{error:string}}
 */
function loadKdm(filePath) {
  let xml;
  try { xml = fs.readFileSync(filePath, 'utf8'); } catch (err) { return { error: 'Could not read the file: ' + err.message }; }
  let kdm;
  try { kdm = readKdm(xml); } catch (err) { return { error: err.message }; }

  let id;
  try { id = identity(); } catch (err) { return { error: err.message }; }
  const keys = unwrapKeys(kdm, id.privateKey);
  if (!keys.size) {
    return {
      error: 'This KDM was not made for this player.\n\n' +
        'It is addressed to:\n  ' + (kdm.recipientSubject || 'serial ' + kdm.recipientSerial) + '\n\n' +
        'This player is:\n  ' + id.subject + '\n\n' +
        'Send the issuer this player\'s certificate (File ▸ Export Player Certificate…) and ask for a KDM made for it.',
    };
  }

  const dir = kdmDir();
  if (dir) {
    try {
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, (kdm.cplId || 'unknown') + '_' + (kdm.id || Date.now()) + '.xml'), xml);
    } catch (_) { /* usable this session regardless */ }
  }
  return {
    cplId: kdm.cplId, title: kdm.title, notBefore: kdm.notBefore, notAfter: kdm.notAfter,
    keys: keys.size, warning: windowProblem(kdm),
  };
}

/** KDM XML files worth trying for a composition: kept ones, then any beside the package. */
function candidateKdms(comp) {
  const files = [];
  const dir = kdmDir();
  if (dir && comp.id) {
    try {
      for (const n of fs.readdirSync(dir)) if (n.startsWith(comp.id + '_')) files.push(path.join(dir, n));
    } catch (_) { /* none kept */ }
  }
  for (const d of [comp.dir, path.dirname(comp.dir)]) {
    try {
      for (const n of fs.readdirSync(d)) {
        if (!/\.xml$/i.test(n)) continue;
        const p = path.join(d, n);
        try { if (fs.statSync(p).size < 4 * 1024 * 1024) files.push(p); } catch (_) { /* gone */ }
      }
    } catch (_) { /* unreadable */ }
  }
  return files;
}

/**
 * The content keys for a composition.
 *
 * @param {object} comp  From dcp.parseCpl(): needs id, dir and each track's keyId.
 * @returns {{keys:Map<string,string>}|{error:string}}
 */
function keysFor(comp) {
  const wanted = [];
  for (const r of comp.reels) {
    for (const t of [r.picture, r.sound]) if (t && t.keyId && !wanted.includes(t.keyId)) wanted.push(t.keyId);
  }
  if (!wanted.length) return { keys: new Map() };

  let id;
  try { id = identity(); } catch (err) { return { error: err.message }; }

  const keys = new Map();
  let closed = null;        // a KDM that fits but is outside its dates
  let foreign = null;       // a KDM for this composition, made for someone else
  for (const file of candidateKdms(comp)) {
    let kdm;
    try {
      const xml = fs.readFileSync(file, 'utf8');
      if (!isKdm(xml)) continue;
      kdm = readKdm(xml);
    } catch (_) { continue; }
    if (kdm.cplId !== comp.id) continue;
    const got = unwrapKeys(kdm, id.privateKey);
    if (!got.size) { foreign = kdm; continue; }
    const problem = windowProblem(kdm);
    if (problem) { closed = problem; continue; }
    for (const [k, v] of got) keys.set(k, v);
    if (wanted.every((k) => keys.has(k))) return { keys };
  }

  if (keys.size) {
    return { error: 'The KDM for this DCP does not carry all of its keys (' +
      wanted.filter((k) => !keys.has(k)).length + ' of ' + wanted.length + ' missing).' };
  }
  if (closed) return { error: closed };
  if (foreign) {
    return { error: 'The KDM found for this DCP was made for a different certificate (' +
      (foreign.recipientSubject || 'serial ' + foreign.recipientSerial) + '), not this player.' };
  }
  return { error: 'This DCP is encrypted and no KDM for it has been loaded.' };
}

module.exports = {
  configure,
  identity,
  exportCertificate,
  loadKdm,
  keysFor,
  readKdm,
  isKdm,
};
