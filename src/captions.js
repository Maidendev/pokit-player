/**
 * PokitPlayer — Caption & Subtitle Module
 *
 * Parses the sidecar timed-text formats delivery specs require into one cue
 * model, and extracts embedded CEA-608 captions out of MXF / MPEG-TS / MOV so
 * they can be verified against picture.
 *
 * Common cue model:
 *   { start: seconds, end: seconds, text: 'line1\nline2', region: 'bottom'|... }
 *
 * SCOPE NOTE: CEA-708 is deliberately NOT handled here. FFmpeg's cc_dec
 * decodes the 608 compatibility bytes only; real 708 needs a window/pen/service
 * state machine with Unicode support. See PINNED.md.
 */

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { FFMPEG } = require('./transcoder');

const SIDECAR_EXTENSIONS = ['.srt', '.vtt', '.webvtt', '.scc', '.ttml', '.xml', '.itt', '.dfxp', '.stl'];

// ---------------------------------------------------------------------------
// Timestamp parsing
// ---------------------------------------------------------------------------

// SRT uses comma for the fractional separator, WebVTT uses a period, and
// WebVTT may omit the hours field entirely.
function parseTimestamp(str) {
  const m = String(str).trim().match(/^(?:(\d+):)?(\d{1,2}):(\d{1,2})[.,](\d{1,3})$/);
  if (!m) return null;
  const hours = m[1] ? parseInt(m[1], 10) : 0;
  const minutes = parseInt(m[2], 10);
  const seconds = parseInt(m[3], 10);
  const millis = parseInt(m[4].padEnd(3, '0'), 10);
  return hours * 3600 + minutes * 60 + seconds + millis / 1000;
}

/**
 * SMPTE timecode → seconds. Drop-frame is signalled by a semicolon before the
 * frames field and skips 2 frame numbers per minute except every tenth minute.
 */
function timecodeToSeconds(tc, fps) {
  const m = String(tc).trim().match(/^(\d{1,2}):(\d{2}):(\d{2})([:;.])(\d{2,3})$/);
  if (!m) return null;
  const [, hh, mm, ss, sep, ff] = m;
  const hours = parseInt(hh, 10);
  const minutes = parseInt(mm, 10);
  const seconds = parseInt(ss, 10);
  const frames = parseInt(ff, 10);
  const dropFrame = sep === ';';

  if (dropFrame) {
    // 29.97 DF: total frames = elapsed frames minus the dropped ones.
    const dropPerMinute = 2;
    const totalMinutes = hours * 60 + minutes;
    const droppedFrames = dropPerMinute * (totalMinutes - Math.floor(totalMinutes / 10));
    const frameNumber =
      ((hours * 3600 + minutes * 60 + seconds) * 30 + frames) - droppedFrames;
    return frameNumber / 29.97;
  }

  const rate = fps || 30;
  return hours * 3600 + minutes * 60 + seconds + frames / rate;
}

// ---------------------------------------------------------------------------
// SRT / WebVTT
// ---------------------------------------------------------------------------

// SRT and WebVTT both allow inline styling markup (<i>, <b>, <c.classname>,
// <v Speaker>). Strip it to plain text — the overlay renders text, not HTML.
function stripInlineMarkup(text) {
  return text.replace(/<[^>]+>/g, '').trim();
}

function parseSrt(content) {
  const cues = [];
  // Blocks are separated by blank lines; tolerate CRLF and a BOM.
  const blocks = content.replace(/^﻿/, '').replace(/\r\n/g, '\n').split(/\n{2,}/);

  for (const block of blocks) {
    const lines = block.split('\n').filter((l) => l.trim() !== '');
    if (!lines.length) continue;

    // An optional numeric counter precedes the timing line.
    let timingIndex = lines.findIndex((l) => l.includes('-->'));
    if (timingIndex === -1) continue;

    const [startStr, endStr] = lines[timingIndex].split('-->');
    const start = parseTimestamp(startStr);
    const end = parseTimestamp(endStr);
    if (start === null || end === null) continue;

    cues.push({
      start,
      end,
      text: stripInlineMarkup(lines.slice(timingIndex + 1).join('\n')),
    });
  }
  return cues;
}

function parseWebVtt(content) {
  // WebVTT is SRT plus a header, cue identifiers and settings after the timing.
  const body = content.replace(/^﻿/, '').replace(/\r\n/g, '\n')
    .replace(/^WEBVTT[^\n]*\n/, '');

  const cues = [];
  for (const block of body.split(/\n{2,}/)) {
    const lines = block.split('\n').filter((l) => l.trim() !== '');
    const timingIndex = lines.findIndex((l) => l.includes('-->'));
    if (timingIndex === -1) continue;

    // Strip cue settings (align:, line:, position:) that follow the end time.
    const timing = lines[timingIndex].split('-->');
    const start = parseTimestamp(timing[0]);
    const end = parseTimestamp(timing[1].trim().split(/\s+/)[0]);
    if (start === null || end === null) continue;

    cues.push({
      start,
      end,
      text: stripInlineMarkup(lines.slice(timingIndex + 1).join('\n')),
    });
  }
  return cues;
}

// ---------------------------------------------------------------------------
// SCC (Scenarist Closed Captions) — raw CEA-608 byte pairs on a timecode grid
// ---------------------------------------------------------------------------

// The 608 basic character set, indexed by the low 7 bits of a printable byte.
const CEA608_BASIC = {
  0x20: ' ', 0x21: '!', 0x22: '"', 0x23: '#', 0x24: '$', 0x25: '%', 0x26: '&',
  0x27: '’', 0x28: '(', 0x29: ')', 0x2a: 'á', 0x2b: '+', 0x2c: ',',
  0x2d: '-', 0x2e: '.', 0x2f: '/', 0x30: '0', 0x31: '1', 0x32: '2', 0x33: '3',
  0x34: '4', 0x35: '5', 0x36: '6', 0x37: '7', 0x38: '8', 0x39: '9', 0x3a: ':',
  0x3b: ';', 0x3c: '<', 0x3d: '=', 0x3e: '>', 0x3f: '?', 0x40: '@', 0x41: 'A',
  0x42: 'B', 0x43: 'C', 0x44: 'D', 0x45: 'E', 0x46: 'F', 0x47: 'G', 0x48: 'H',
  0x49: 'I', 0x4a: 'J', 0x4b: 'K', 0x4c: 'L', 0x4d: 'M', 0x4e: 'N', 0x4f: 'O',
  0x50: 'P', 0x51: 'Q', 0x52: 'R', 0x53: 'S', 0x54: 'T', 0x55: 'U', 0x56: 'V',
  0x57: 'W', 0x58: 'X', 0x59: 'Y', 0x5a: 'Z', 0x5b: '[', 0x5c: 'é',
  0x5d: ']', 0x5e: 'í', 0x5f: 'ó', 0x60: 'ú', 0x61: 'a',
  0x62: 'b', 0x63: 'c', 0x64: 'd', 0x65: 'e', 0x66: 'f', 0x67: 'g', 0x68: 'h',
  0x69: 'i', 0x6a: 'j', 0x6b: 'k', 0x6c: 'l', 0x6d: 'm', 0x6e: 'n', 0x6f: 'o',
  0x70: 'p', 0x71: 'q', 0x72: 'r', 0x73: 's', 0x74: 't', 0x75: 'u', 0x76: 'v',
  0x77: 'w', 0x78: 'x', 0x79: 'y', 0x7a: 'z', 0x7b: 'ç', 0x7c: '÷',
  0x7d: 'Ñ', 0x7e: 'ñ', 0x7f: '█',
};

/**
 * Parse SCC into cues.
 *
 * Each line is "TIMECODE\tHHHH HHHH ..." where every hex word is two 608 bytes
 * with odd parity in the high bit. Control codes (0x10–0x1f in the first byte)
 * drive pop-on/roll-up behaviour; this decoder handles the common structure:
 * text accumulates until an End-of-Caption / Erase-Displayed-Memory flips it on
 * screen or clears it.
 */
function parseScc(content, fps) {
  const cues = [];
  const lines = content.replace(/\r\n/g, '\n').split('\n');

  let pending = '';          // text being built in the off-screen buffer
  let displayed = null;      // { start, text } currently on screen
  let lastControl = null;    // for de-duplicating doubled control codes

  for (const line of lines) {
    if (/^Scenarist_SCC/i.test(line) || line.trim() === '') continue;

    const match = line.match(/^(\d{2}:\d{2}:\d{2}[:;]\d{2})\s+(.*)$/);
    if (!match) continue;

    const time = timecodeToSeconds(match[1], fps);
    if (time === null) continue;

    for (const word of match[2].trim().split(/\s+/)) {
      if (!/^[0-9a-fA-F]{4}$/.test(word)) continue;
      const value = parseInt(word, 16);
      // Strip odd parity to get the 7-bit payload.
      const b1 = (value >> 8) & 0x7f;
      const b2 = value & 0x7f;

      if (b1 >= 0x10 && b1 <= 0x1f) {
        // Control code pair. The 608 spec requires every control code to be
        // transmitted TWICE for error resilience, so an immediate repeat of
        // the same pair is the same command — acting on both would emit empty
        // captions and swallow the real text.
        const controlKey = (b1 << 8) | b2;
        if (lastControl === controlKey) { lastControl = null; continue; }
        lastControl = controlKey;

        const cmd = b2;
        if (cmd === 0x2f) {            // EOC — swap buffer to screen
          if (displayed && displayed.text) {
            displayed.end = time;
            cues.push(displayed);
          }
          displayed = { start: time, end: null, text: pending.trim() };
          pending = '';
        } else if (cmd === 0x2c) {     // EDM — erase displayed memory
          if (displayed && displayed.text) {
            displayed.end = time;
            cues.push(displayed);
            displayed = null;
          }
        } else if (cmd === 0x2d) {     // Carriage return (roll-up)
          pending += '\n';
        } else if (cmd === 0x2e) {     // ENM — erase non-displayed memory
          pending = '';
        }
        // PAC / mid-row codes affect position and styling; ignored for now.
        continue;
      }

      lastControl = null;   // any text byte breaks a control-code pair run
      if (b1 >= 0x20) pending += CEA608_BASIC[b1] || '';
      if (b2 >= 0x20) pending += CEA608_BASIC[b2] || '';
    }
  }

  // A caption still on screen at end of file runs to the last timestamp + 2s.
  if (displayed && displayed.text) {
    displayed.end = displayed.start + 2;
    cues.push(displayed);
  }

  return cues.filter((c) => c.text && c.end > c.start);
}

// ---------------------------------------------------------------------------
// TTML family (IMSC1, iTT, SMPTE-TT, DFXP)
// ---------------------------------------------------------------------------

/**
 * TTML timing attributes come in several flavours: clock time
 * ("00:00:12.400"), offset time ("12.4s", "300f"), and SMPTE frame time.
 */
function parseTtmlTime(value, fps, tickRate) {
  if (!value) return null;
  const str = String(value).trim();

  const offset = str.match(/^([\d.]+)(h|m|s|ms|f|t)$/);
  if (offset) {
    const n = parseFloat(offset[1]);
    switch (offset[2]) {
      case 'h': return n * 3600;
      case 'm': return n * 60;
      case 's': return n;
      case 'ms': return n / 1000;
      case 'f': return n / (fps || 25);
      case 't': return n / (tickRate || 10000000);
      default: return null;
    }
  }

  // Clock time, with either fractional seconds or a frames field.
  const clock = str.match(/^(\d{2,}):(\d{2}):(\d{2})(?:[.:](\d+))?$/);
  if (clock) {
    const [, hh, mm, ss, frac] = clock;
    let seconds = parseInt(hh, 10) * 3600 + parseInt(mm, 10) * 60 + parseInt(ss, 10);
    if (frac !== undefined) {
      // A colon before the last field means frames; a period means fraction.
      seconds += str.includes('.')
        ? parseFloat('0.' + frac)
        : parseInt(frac, 10) / (fps || 25);
    }
    return seconds;
  }
  return null;
}

function decodeXmlEntities(str) {
  return str
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&amp;/g, '&');   // last, so decoded entities aren't re-decoded
}

function parseTtml(content, fps) {
  const cues = [];

  // frameRate / tickRate live on the root <tt> element.
  const rateMatch = content.match(/ttp:frameRate\s*=\s*["'](\d+)["']/);
  const multMatch = content.match(/ttp:frameRateMultiplier\s*=\s*["'](\d+)\s+(\d+)["']/);
  const tickMatch = content.match(/ttp:tickRate\s*=\s*["'](\d+)["']/);
  let docFps = rateMatch ? parseInt(rateMatch[1], 10) : (fps || 25);
  if (multMatch) docFps = docFps * (parseInt(multMatch[1], 10) / parseInt(multMatch[2], 10));
  const tickRate = tickMatch ? parseInt(tickMatch[1], 10) : null;

  // <p> elements carry the cues. Attributes may appear in any order.
  const pattern = /<p\b([^>]*)>([\s\S]*?)<\/p>/g;
  let m;
  while ((m = pattern.exec(content)) !== null) {
    const attrs = m[1];
    const begin = (attrs.match(/\bbegin\s*=\s*["']([^"']+)["']/) || [])[1];
    const end = (attrs.match(/\bend\s*=\s*["']([^"']+)["']/) || [])[1];
    const dur = (attrs.match(/\bdur\s*=\s*["']([^"']+)["']/) || [])[1];

    const start = parseTtmlTime(begin, docFps, tickRate);
    let stop = parseTtmlTime(end, docFps, tickRate);
    if (stop === null && dur !== undefined) {
      const d = parseTtmlTime(dur, docFps, tickRate);
      if (d !== null && start !== null) stop = start + d;
    }
    if (start === null || stop === null) continue;

    const text = decodeXmlEntities(
      m[2]
        .replace(/<br\s*\/?>/gi, '\n')
        .replace(/<[^>]+>/g, '')      // drop span/styling markup
    ).replace(/[ \t]+\n/g, '\n').trim();

    if (text) cues.push({ start, end: stop, text });
  }

  return cues;
}

// ---------------------------------------------------------------------------
// EBU STL (binary, 1024-byte blocks)
// ---------------------------------------------------------------------------

/**
 * EBU Tech 3264 STL: a 1024-byte General Subtitle Information block followed by
 * 128-byte Text and Timing Information blocks.
 */
function parseStl(buffer, fps) {
  const cues = [];
  if (buffer.length < 1024) return cues;

  // Disk Format Code at offset 3 tells us 25 or 30 fps.
  const dfc = buffer.toString('latin1', 3, 11);
  const rate = dfc.includes('30') ? 30 : 25;
  const frameRate = fps || rate;

  // Character code table at offset 12 selects the text encoding.
  const codePageDescriptor = buffer.toString('latin1', 12, 14);
  const isLatin = codePageDescriptor === '00';

  for (let offset = 1024; offset + 128 <= buffer.length; offset += 128) {
    const block = buffer.slice(offset, offset + 128);

    // Timecode In / Out at bytes 5-8 and 9-12, as HH MM SS FF.
    const startSeconds =
      block[5] * 3600 + block[6] * 60 + block[7] + block[8] / frameRate;
    const endSeconds =
      block[9] * 3600 + block[10] * 60 + block[11] + block[12] / frameRate;

    // Text Field is the last 112 bytes; 0x8f pads the unused tail.
    const textBytes = block.slice(16, 128);
    let text = '';
    for (const byte of textBytes) {
      if (byte === 0x8f) break;              // unused space
      if (byte === 0x8a) { text += '\n'; continue; }  // newline
      if (byte >= 0x20 && byte <= 0x7e) text += String.fromCharCode(byte);
      else if (isLatin && byte >= 0xa0) text += Buffer.from([byte]).toString('latin1');
    }

    text = text.trim();
    if (text && endSeconds > startSeconds) {
      cues.push({ start: startSeconds, end: endSeconds, text });
    }
  }

  return cues;
}

// ---------------------------------------------------------------------------
// Public loader
// ---------------------------------------------------------------------------

/**
 * Load a sidecar caption file and return { format, cues }.
 * Throws with a specific message on a malformed file rather than silently
 * returning nothing — a caption file that parses to zero cues is a QC failure
 * the operator needs to see.
 */
function loadSidecar(filePath, fps) {
  const ext = path.extname(filePath).toLowerCase();
  let cues;
  let format;

  if (ext === '.stl') {
    const buffer = fs.readFileSync(filePath);
    format = 'EBU STL';
    cues = parseStl(buffer, fps);
  } else {
    const content = fs.readFileSync(filePath, 'utf8');
    if (ext === '.srt') {
      format = 'SubRip (SRT)';
      cues = parseSrt(content);
    } else if (ext === '.vtt' || ext === '.webvtt') {
      format = 'WebVTT';
      cues = parseWebVtt(content);
    } else if (ext === '.scc') {
      format = 'Scenarist SCC (CEA-608)';
      cues = parseScc(content, fps);
    } else if (ext === '.ttml' || ext === '.xml' || ext === '.itt' || ext === '.dfxp') {
      // iTT and SMPTE-TT are TTML profiles, so one parser covers all of them.
      format = ext === '.itt' ? 'iTT (TTML)'
        : ext === '.dfxp' ? 'DFXP (TTML)' : 'TTML / IMSC1';
      cues = parseTtml(content, fps);
    } else {
      throw new Error('Unsupported caption format: ' + ext);
    }
  }

  if (!cues.length) {
    throw new Error('No cues found — file may be malformed or empty (' + format + ')');
  }

  cues.sort((a, b) => a.start - b.start);
  return { format, cues, path: filePath };
}

/**
 * Extract embedded CEA-608 captions from a media file.
 *
 * FFmpeg's "subcc" pseudo-stream on the movie filter surfaces the closed
 * captions riding in the video stream (MXF, MPEG-TS and MOV all carry them
 * this way), which we convert to SRT and reuse the SRT parser on.
 */
function extractEmbedded608(filePath, outputPath) {
  return new Promise((resolve, reject) => {
    // The movie filter's filename sits inside a filtergraph, where ':' and '\'
    // are both separators — a Windows drive letter ("C:/…") gets parsed as an
    // option boundary no matter how it is escaped. Running ffmpeg from the
    // file's own directory and passing the bare basename avoids the problem
    // entirely; only the remaining filtergraph metacharacters need escaping.
    const workingDir = path.dirname(filePath);
    const escapedName = path.basename(filePath).replace(/([\\':[\],;])/g, '\\$1');

    const args = [
      '-hide_banner',
      '-loglevel', 'error',
      '-y',
      '-f', 'lavfi',
      '-i', 'movie=' + escapedName + '[out0+subcc]',
      '-map', '0:s:0',
      outputPath,
    ];

    const proc = spawn(FFMPEG, args, { windowsHide: true, cwd: workingDir });
    let stderr = '';
    proc.stderr.on('data', (d) => { stderr += d.toString(); });

    proc.on('error', (err) => reject(new Error('608 extraction failed: ' + err.message)));
    proc.on('close', (code) => {
      if (code !== 0) {
        reject(new Error('No embedded CEA-608 captions found' +
          (stderr.trim() ? ' (' + stderr.trim().split('\n').pop() + ')' : '')));
        return;
      }
      try {
        const result = loadSidecar(outputPath);
        result.format = 'Embedded CEA-608';
        resolve(result);
      } catch (err) {
        // ffmpeg exits 0 with an empty file when the video carries no CC data,
        // so an empty parse here means "none present", not "malformed".
        reject(/No cues found/.test(err.message)
          ? new Error('No embedded CEA-608 captions present in this file')
          : err);
      }
    });
  });
}

module.exports = {
  loadSidecar,
  extractEmbedded608,
  SIDECAR_EXTENSIONS,
  _internal: {
    parseSrt, parseWebVtt, parseScc, parseTtml, parseStl,
    parseTimestamp, timecodeToSeconds, parseTtmlTime,
  },
};
