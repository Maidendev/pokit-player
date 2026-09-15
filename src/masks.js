/**
 * MaidenPlayer — Aspect-ratio masks and framing guides (renderer side)
 *
 * VFX shots usually arrive as full-frame renders, and the question in review
 * is "how does this sit in the delivery frame?" This draws that frame over
 * the picture: the area outside a chosen aspect ratio is dimmed (or fully
 * masked, at opacity 1) and optional guides — centre crosshair, action safe,
 * title safe — are drawn relative to the masked frame, which is where they
 * belong once a mask is up.
 *
 * Safe-area percentages follow SMPTE ST 2046-1 / EBU R95 for 16:9 and wider:
 * action safe 93%, title safe 90%. The old 4:3 figures (90% / 80%) came from
 * CRT overscan and are not what a modern delivery spec asks for.
 *
 * Pure geometry on a 2D canvas. The canvas sits over the <video> (and over the
 * LUT canvas when that is on), takes no pointer events, and is redrawn on
 * resize and whenever the video's dimensions become known.
 */

(function () {
  'use strict';

  const ACTION_SAFE = 0.93;
  const TITLE_SAFE = 0.90;

  /**
   * @param {HTMLCanvasElement} canvas   Overlay canvas filling the video container.
   * @param {HTMLVideoElement}  video    Source of the picture dimensions.
   */
  function create(canvas, video) {
    const ctx = canvas.getContext('2d');
    const state = { ratio: null, opacity: 0.7, crosshair: false, actionSafe: false, titleSafe: false, label: null };

    /** The rectangle the video occupies inside its container (object-fit: contain). */
    function videoRect(cw, ch) {
      const vw = video.videoWidth, vh = video.videoHeight;
      if (!vw || !vh) return null;
      const scale = Math.min(cw / vw, ch / vh);
      const dw = vw * scale, dh = vh * scale;
      return { x: (cw - dw) / 2, y: (ch - dh) / 2, w: dw, h: dh };
    }

    /** The target frame at `ratio`, centred inside `rect` and no bigger than it. */
    function frameRect(rect, ratio) {
      const a = rect.w / rect.h;
      let w, h;
      if (ratio >= a) { w = rect.w; h = rect.w / ratio; } else { h = rect.h; w = rect.h * ratio; }
      return { x: rect.x + (rect.w - w) / 2, y: rect.y + (rect.h - h) / 2, w, h };
    }

    function centred(rect, pct) {
      return { x: rect.x + rect.w * (1 - pct) / 2, y: rect.y + rect.h * (1 - pct) / 2, w: rect.w * pct, h: rect.h * pct };
    }

    function snap(v) { return Math.round(v) + 0.5; }   // crisp 1px lines

    function strokeRect(r, style, dash) {
      ctx.save();
      ctx.strokeStyle = style;
      ctx.lineWidth = 1;
      ctx.setLineDash(dash || []);
      ctx.strokeRect(snap(r.x), snap(r.y), Math.round(r.w) - 1, Math.round(r.h) - 1);
      ctx.restore();
    }

    function label(text, x, y, align) {
      ctx.save();
      ctx.font = '10px "SF Mono", "Fira Code", Consolas, monospace';
      ctx.textAlign = align || 'left';
      ctx.textBaseline = 'top';
      ctx.fillStyle = 'rgba(0,0,0,0.55)';
      const w = ctx.measureText(text).width + 8;
      const lx = align === 'right' ? x - w : x;
      ctx.fillRect(lx, y, w, 14);
      ctx.fillStyle = 'rgba(255,255,255,0.8)';
      ctx.fillText(text, align === 'right' ? x - 4 : x + 4, y + 2);
      ctx.restore();
    }

    function redraw() {
      const parent = canvas.parentElement;
      const cw = parent ? parent.clientWidth : canvas.clientWidth;
      const ch = parent ? parent.clientHeight : canvas.clientHeight;
      const dpr = window.devicePixelRatio || 1;
      if (canvas.width !== Math.round(cw * dpr) || canvas.height !== Math.round(ch * dpr)) {
        canvas.width = Math.round(cw * dpr);
        canvas.height = Math.round(ch * dpr);
      }
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, cw, ch);

      const active = state.ratio || state.crosshair || state.actionSafe || state.titleSafe;
      canvas.style.display = active ? 'block' : 'none';
      if (!active) return;

      const vr = videoRect(cw, ch);
      if (!vr) return;

      // Guides are relative to the delivery frame when a mask is up, and to
      // the full picture when it is not.
      let frame = vr;
      if (state.ratio) {
        frame = frameRect(vr, state.ratio);
        // Dim everything inside the picture but outside the frame.
        ctx.save();
        ctx.fillStyle = 'rgba(0,0,0,' + Math.max(0, Math.min(1, state.opacity)) + ')';
        ctx.beginPath();
        ctx.rect(vr.x, vr.y, vr.w, vr.h);
        ctx.rect(frame.x, frame.y, frame.w, frame.h);
        ctx.fill('evenodd');
        ctx.restore();
        strokeRect(frame, 'rgba(255,255,255,0.45)');
        label(state.label || state.ratio.toFixed(2), frame.x, frame.y, 'left');
      }

      if (state.actionSafe) {
        const r = centred(frame, ACTION_SAFE);
        strokeRect(r, 'rgba(255, 210, 60, 0.75)');
        label('ACTION 93%', r.x + r.w, r.y, 'right');
      }
      if (state.titleSafe) {
        const r = centred(frame, TITLE_SAFE);
        strokeRect(r, 'rgba(120, 220, 255, 0.75)', [4, 4]);
        label('TITLE 90%', r.x + r.w, r.y + (state.actionSafe ? 16 : 0), 'right');
      }
      if (state.crosshair) {
        const cx = snap(frame.x + frame.w / 2), cy = snap(frame.y + frame.h / 2);
        const gap = Math.max(8, Math.min(frame.w, frame.h) * 0.04);
        ctx.save();
        ctx.strokeStyle = 'rgba(255,255,255,0.7)';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(frame.x, cy); ctx.lineTo(cx - gap, cy);
        ctx.moveTo(cx + gap, cy); ctx.lineTo(frame.x + frame.w, cy);
        ctx.moveTo(cx, frame.y); ctx.lineTo(cx, cy - gap);
        ctx.moveTo(cx, cy + gap); ctx.lineTo(cx, frame.y + frame.h);
        ctx.stroke();
        // Small centre tick so the exact centre is readable inside the gap.
        ctx.beginPath();
        ctx.arc(cx, cy, 2.5, 0, Math.PI * 2);
        ctx.stroke();
        ctx.restore();
      }
    }

    /** Merge new settings and redraw. `ratio` null/0 turns the mask off. */
    function setState(partial) {
      Object.assign(state, partial || {});
      if (!(state.ratio > 0)) state.ratio = null;
      redraw();
    }

    return { setState, redraw, get state() { return state; }, ACTION_SAFE, TITLE_SAFE };
  }

  window.MaidenMasks = { create, ACTION_SAFE, TITLE_SAFE };
})();
