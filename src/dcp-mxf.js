/**
 * MaidenPlayer — reading frames straight out of a DCP track file
 *
 * ffmpeg reads DCP track files for the player, with one exception this
 * module exists for: the SOUND of an ENCRYPTED package. ffmpeg (6.1) decrypts
 * such a file correctly, but after a seek it stamps the decrypted sound with
 * times in the wrong unit — edit units where it should be samples — so a
 * reel never reaches its out-point and the next reel never starts. (Checked
 * against the same sound unencrypted: every reel after the first played the
 * wrong audio. Picture does not have the problem; its time base IS the edit
 * rate.) Sound is small, so it is read and decrypted here instead and handed
 * to ffmpeg as plain PCM.
 *
 * A track file as asdcplib and every DCP mastering tool writes it:
 *
 *   header partition   metadata
 *   body partition     one KLV per frame ("edit unit"), all the essence
 *   footer partition   the index: where each edit unit starts
 *   random index pack  where the partitions are
 *
 * In an encrypted file each frame's KLV is replaced by an "encrypted
 * triplet" (SMPTE ST 429-6): the original key and length, then IV, an
 * encrypted check value and the AES-128-CBC ciphertext.
 */

const fs = require('fs');
const crypto = require('crypto');

const KEY_INDEX_SEGMENT = '060e2b34025301010d01020101100100';
const KEY_RIP = '060e2b34020501010d01020101110100';
const KEY_TRIPLET = '060e2b34020401070d010301027e0100';
const KEY_ESSENCE_PREFIX = '060e2b34010201010d010301';
const CHECK_VALUE = Buffer.from('CHUKCHUKCHUKCHUK');

/** Decode a BER length at `buf[at]`. → { len, size } where size is the bytes the length itself took. */
function ber(buf, at) {
  const first = buf[at];
  if (!(first & 0x80)) return { len: first, size: 1 };
  const n = first & 0x7f;
  if (n < 1 || n > 8) throw new Error('Bad length in MXF');
  let len = 0;
  for (let i = 0; i < n; i++) len = len * 256 + buf[at + 1 + i];
  return { len, size: 1 + n };
}

class TrackFile {
  /** @param {string} filePath  A picture or sound MXF track file. */
  constructor(filePath) {
    this.path = filePath;
    this.fd = fs.openSync(filePath, 'r');
    try {
      this.size = fs.fstatSync(this.fd).size;
      this.essenceStart = this.findEssenceStart();
      this.readIndex();
    } catch (err) {
      this.close();
      throw err;
    }
  }

  close() {
    if (this.fd !== null && this.fd !== undefined) {
      try { fs.closeSync(this.fd); } catch (_) { /* ignore */ }
      this.fd = null;
    }
  }

  read(pos, n) {
    const buf = Buffer.alloc(n);
    const got = fs.readSync(this.fd, buf, 0, n, pos);
    return got === n ? buf : buf.subarray(0, got);
  }

  /** Key and length of the KLV at `pos`. */
  klv(pos) {
    const head = this.read(pos, 25);
    if (head.length < 17) throw new Error('Unexpected end of track file');
    const l = ber(head, 16);
    return { key: head.toString('hex', 0, 16), valueAt: pos + 16 + l.size, len: l.len, next: pos + 16 + l.size + l.len };
  }

  /** File position of the first frame: the first essence (or encrypted) KLV. */
  findEssenceStart() {
    let pos = 0;
    for (let i = 0; i < 4096 && pos < this.size; i++) {
      const k = this.klv(pos);
      if (k.key === KEY_TRIPLET || k.key.startsWith(KEY_ESSENCE_PREFIX)) return pos;
      pos = k.next;
    }
    throw new Error('No essence found in track file');
  }

  /**
   * The index, from the footer partition. Either every edit unit is the same
   * size (`unitBytes`, usual for sound) or each has its own offset (`offsets`).
   */
  readIndex() {
    this.unitBytes = 0;
    this.offsets = null;

    // The random index pack is the last thing in the file; its last 4 bytes
    // are its own length. Its last entry is the footer partition.
    const tail = this.read(this.size - 4, 4);
    const ripAt = this.size - tail.readUInt32BE(0);
    let footerAt = -1;
    if (ripAt > 0 && ripAt < this.size) {
      const rip = this.klv(ripAt);
      if (rip.key === KEY_RIP && rip.len >= 16) {
        const v = this.read(rip.valueAt, rip.len);
        footerAt = Number(v.readBigUInt64BE(v.length - 4 - 8));
      }
    }
    if (footerAt < 0) {
      // No usable RIP: the header partition pack says where the footer is.
      const pack = this.klv(0);
      footerAt = Number(this.read(pack.valueAt + 24, 8).readBigUInt64BE(0));
    }
    if (!(footerAt > 0 && footerAt < this.size)) throw new Error('Track file has no footer partition (incomplete file?)');

    const entries = [];
    let pos = footerAt;
    while (pos < this.size - 16) {
      const k = this.klv(pos);
      if (k.key === KEY_RIP) break;
      if (k.key === KEY_INDEX_SEGMENT) {
        const v = this.read(k.valueAt, k.len);
        let start = 0;
        let seg = null;
        for (let p = 0; p + 4 <= v.length;) {
          const tag = v.readUInt16BE(p);
          const len = v.readUInt16BE(p + 2);
          const at = p + 4;
          if (tag === 0x3f05) { const n = v.readUInt32BE(at); if (n) this.unitBytes = n; }
          else if (tag === 0x3f0c) start = Number(v.readBigUInt64BE(at));
          else if (tag === 0x3f0a) seg = { count: v.readUInt32BE(at), each: v.readUInt32BE(at + 4), at: at + 8 };
          p = at + len;
        }
        if (seg) {
          for (let i = 0; i < seg.count; i++) {
            // temporal offset, key-frame offset, flags, then the stream offset
            entries[start + i] = Number(v.readBigUInt64BE(seg.at + i * seg.each + 3));
          }
        }
      }
      pos = k.next;
    }
    if (entries.length) this.offsets = entries;
    if (!this.unitBytes && !this.offsets) throw new Error('Track file has no index');
  }

  /** File position of edit unit `n`. */
  frameAt(n) {
    if (this.offsets) {
      const o = this.offsets[n];
      if (o === undefined) throw new Error('Frame ' + n + ' is past the end of the track file');
      return this.essenceStart + o;
    }
    return this.essenceStart + n * this.unitBytes;
  }

  /**
   * The essence of edit unit `n`, decrypted if it is encrypted.
   *
   * @param {number} n
   * @param {Buffer|null} key  16-byte AES key; required for an encrypted file.
   */
  frame(n, key) {
    const k = this.klv(this.frameAt(n));
    if (k.next > this.size) throw new Error('Frame ' + n + ' is past the end of the track file');
    if (k.key.startsWith(KEY_ESSENCE_PREFIX)) return this.read(k.valueAt, k.len);
    if (k.key !== KEY_TRIPLET) throw new Error('Frame ' + n + ' is not where the index says it is');
    if (!key) throw new Error('This track file is encrypted and no key was given');

    // Five length-prefixed items: context link, plaintext offset, source key,
    // source length, then the encrypted source value. (An integrity code may
    // follow; it is not checked.)
    const v = this.read(k.valueAt, k.len);
    let p = 0;
    const item = () => { const l = ber(v, p); const at = p + l.size; p = at + l.len; return v.subarray(at, at + l.len); };
    item();                                                    // cryptographic context link
    const clear = Number(item().readBigUInt64BE(0));           // bytes left unencrypted at the start
    item();                                                    // the essence key this frame had
    const sourceLen = Number(item().readBigUInt64BE(0));
    const esv = item();
    if (esv.length < 32 + clear) throw new Error('Damaged encrypted frame ' + n);

    const decipher = crypto.createDecipheriv('aes-128-cbc', key, esv.subarray(0, 16));
    decipher.setAutoPadding(false);
    const check = decipher.update(esv.subarray(16, 32));
    if (!check.equals(CHECK_VALUE)) throw new Error('Wrong key for this track file (the KDM does not match it)');
    const body = Buffer.concat([
      esv.subarray(32, 32 + clear),
      decipher.update(esv.subarray(32 + clear)),
      decipher.final(),
    ]);
    return body.subarray(0, sourceLen);
  }
}

module.exports = { TrackFile };
