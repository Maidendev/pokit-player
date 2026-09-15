/**
 * MaidenPlayer — LUT preview (renderer side)
 *
 * Loads a .cube LUT (1D or 3D) and applies it to the playing <video> on a
 * WebGL2 canvas, so a VFX or dailies review can toggle a look on and off
 * without leaving the player. The <video> element keeps playing underneath
 * and stays the transport clock; this only draws its frames through the LUT.
 *
 * WHERE THE LUT IS APPLIED
 *
 * On the desktop it runs here, on the GPU, with the 3D texture's own
 * trilinear interpolation — the right trade for a real-time preview.
 * Everything that leaves the player (SDI output, exports, saved frames)
 * applies the SAME .cube file through ffmpeg's lut3d filter with tetrahedral
 * interpolation instead (see src/editor.js and src/sdi.js), so the file on
 * disk is the higher-quality rendition and the preview is a faithful stand-in.
 *
 * The LUT is applied to the display-referred picture the browser decodes
 * (8-bit, video range already expanded), which is how a viewing LUT is meant
 * to be used. Colour-managing scene-referred sources is a different job.
 */

(function () {
  'use strict';

  // ─── .cube parsing ─────────────────────────────────────────────────────

  /**
   * Parse Adobe/IRIDAS .cube text.
   * @returns {{ title:string|null, size:number, is3D:boolean, domainMin:number[],
   *             domainMax:number[], data:Float32Array }}
   * @throws on a malformed file, with a message naming what is wrong.
   */
  function parseCube(text) {
    const lut = { title: null, size: 0, is3D: false, domainMin: [0, 0, 0], domainMax: [1, 1, 1], data: null };
    const values = [];
    const lines = String(text).split(/\r?\n/);

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();
      if (!line || line[0] === '#') continue;

      const upper = line.toUpperCase();
      if (upper.startsWith('TITLE')) {
        const m = /^TITLE\s+"?(.*?)"?\s*$/i.exec(line);
        lut.title = m ? m[1] : null;
        continue;
      }
      if (upper.startsWith('LUT_3D_SIZE')) {
        lut.size = parseInt(line.split(/\s+/)[1], 10);
        lut.is3D = true;
        continue;
      }
      if (upper.startsWith('LUT_1D_SIZE')) {
        lut.size = parseInt(line.split(/\s+/)[1], 10);
        lut.is3D = false;
        continue;
      }
      if (upper.startsWith('DOMAIN_MIN') || upper.startsWith('LUT_3D_INPUT_RANGE') || upper.startsWith('LUT_1D_INPUT_RANGE')) {
        const parts = line.split(/\s+/).slice(1).map(parseFloat);
        if (upper.startsWith('DOMAIN_MIN')) {
          if (parts.length >= 3) lut.domainMin = parts.slice(0, 3);
        } else if (parts.length >= 2) {
          // "INPUT_RANGE min max" applies to all three channels.
          lut.domainMin = [parts[0], parts[0], parts[0]];
          lut.domainMax = [parts[1], parts[1], parts[1]];
        }
        continue;
      }
      if (upper.startsWith('DOMAIN_MAX')) {
        const parts = line.split(/\s+/).slice(1).map(parseFloat);
        if (parts.length >= 3) lut.domainMax = parts.slice(0, 3);
        continue;
      }
      // Anything else that is not three numbers is an unknown keyword; skip it
      // rather than fail, since vendors add their own.
      const nums = line.split(/[\s,]+/).map(parseFloat);
      if (nums.length >= 3 && nums.slice(0, 3).every((n) => isFinite(n))) {
        values.push(nums[0], nums[1], nums[2]);
      }
    }

    if (!lut.size || lut.size < 2) throw new Error('No LUT_3D_SIZE or LUT_1D_SIZE found — is this a .cube file?');
    const expected = lut.is3D ? lut.size * lut.size * lut.size : lut.size;
    if (values.length / 3 !== expected) {
      throw new Error('Expected ' + expected + ' entries for a ' + (lut.is3D ? lut.size + '×' + lut.size + '×' + lut.size : '1D ' + lut.size) +
        ' LUT, found ' + (values.length / 3));
    }
    if (lut.is3D && lut.size > 129) throw new Error('3D LUT of size ' + lut.size + ' is larger than the GPU path supports (max 129).');
    lut.data = new Float32Array(values);
    return lut;
  }

  // ─── Float → half-float, for a 16-bit LUT texture ──────────────────────

  const f32 = new Float32Array(1);
  const u32 = new Uint32Array(f32.buffer);

  function toHalf(val) {
    f32[0] = val;
    const x = u32[0];
    const sign = (x >> 16) & 0x8000;
    let exp = ((x >> 23) & 0xff) - 127 + 15;
    let mant = x & 0x7fffff;
    if (exp <= 0) {
      if (exp < -10) return sign;                 // underflow → signed zero
      mant = (mant | 0x800000) >> (1 - exp);
      return sign | ((mant + 0x1000) >> 13);
    }
    if (exp >= 0x1f) return sign | 0x7c00;        // overflow → inf
    return sign | (exp << 10) | ((mant + 0x1000) >> 13);
  }

  function toHalfArray(floats) {
    const out = new Uint16Array(floats.length);
    for (let i = 0; i < floats.length; i++) out[i] = toHalf(floats[i]);
    return out;
  }

  // ─── WebGL renderer ────────────────────────────────────────────────────

  const VERT = `#version 300 es
    in vec2 aPos;
    out vec2 vUv;
    void main() {
      // Video textures upload top row first; flip so the picture is upright.
      vUv = vec2(aPos.x * 0.5 + 0.5, 0.5 - aPos.y * 0.5);
      gl_Position = vec4(aPos, 0.0, 1.0);
    }`;

  const FRAG = `#version 300 es
    precision highp float;
    precision highp sampler3D;
    in vec2 vUv;
    out vec4 outColor;
    uniform sampler2D uVideo;
    uniform sampler3D uLut3D;
    uniform sampler2D uLut1D;
    uniform float uSize;
    uniform vec3 uDomainMin;
    uniform vec3 uDomainMax;
    uniform int uMode;            // 0 = bypass, 1 = 3D, 2 = 1D

    void main() {
      vec3 c = texture(uVideo, vUv).rgb;
      if (uMode == 0) { outColor = vec4(c, 1.0); return; }
      vec3 t = clamp((c - uDomainMin) / max(uDomainMax - uDomainMin, vec3(1e-6)), 0.0, 1.0);
      // Sample at texel centres: index 0 sits at 0.5/N, index N-1 at (N-0.5)/N.
      vec3 coord = t * ((uSize - 1.0) / uSize) + (0.5 / uSize);
      if (uMode == 1) {
        outColor = vec4(texture(uLut3D, coord).rgb, 1.0);
      } else {
        float r = texture(uLut1D, vec2(coord.r, 0.5)).r;
        float g = texture(uLut1D, vec2(coord.g, 0.5)).g;
        float b = texture(uLut1D, vec2(coord.b, 0.5)).b;
        outColor = vec4(r, g, b, 1.0);
      }
    }`;

  function compile(gl, type, src) {
    const sh = gl.createShader(type);
    gl.shaderSource(sh, src);
    gl.compileShader(sh);
    if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
      const log = gl.getShaderInfoLog(sh);
      gl.deleteShader(sh);
      throw new Error('LUT shader failed to compile: ' + log);
    }
    return sh;
  }

  /**
   * Create a renderer bound to a canvas. Returns null when WebGL2 is not
   * available, in which case the caller should leave the plain <video> up.
   */
  function createRenderer(canvas) {
    const gl = canvas.getContext('webgl2', { alpha: false, antialias: false, premultipliedAlpha: false, desynchronized: true, preserveDrawingBuffer: false });
    if (!gl) return null;

    const prog = gl.createProgram();
    gl.attachShader(prog, compile(gl, gl.VERTEX_SHADER, VERT));
    gl.attachShader(prog, compile(gl, gl.FRAGMENT_SHADER, FRAG));
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
      throw new Error('LUT shader failed to link: ' + gl.getProgramInfoLog(prog));
    }
    gl.useProgram(prog);

    const quad = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, quad);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    const aPos = gl.getAttribLocation(prog, 'aPos');
    gl.enableVertexAttribArray(aPos);
    gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 0, 0);

    const u = {
      video: gl.getUniformLocation(prog, 'uVideo'),
      lut3d: gl.getUniformLocation(prog, 'uLut3D'),
      lut1d: gl.getUniformLocation(prog, 'uLut1D'),
      size: gl.getUniformLocation(prog, 'uSize'),
      dmin: gl.getUniformLocation(prog, 'uDomainMin'),
      dmax: gl.getUniformLocation(prog, 'uDomainMax'),
      mode: gl.getUniformLocation(prog, 'uMode'),
    };

    // Video texture — unit 0
    const videoTex = gl.createTexture();
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, videoTex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.uniform1i(u.video, 0);

    // 3D LUT — unit 1; 1D LUT — unit 2
    const lut3dTex = gl.createTexture();
    const lut1dTex = gl.createTexture();
    gl.uniform1i(u.lut3d, 1);
    gl.uniform1i(u.lut1d, 2);
    gl.uniform1i(u.mode, 0);

    let current = null;      // parsed LUT
    let enabled = false;
    let precision = null;    // 'half' | 'float' | '8-bit'

    /**
     * Upload a LUT. Tries a 16-bit float texture first (filterable in core
     * WebGL2), then 32-bit float if that extension exists, and only then
     * quantises to 8 bits — a 33-point LUT at 8 bits is visibly banded on
     * a smooth ramp.
     */
    function setLUT(lut) {
      current = lut || null;
      if (!lut) { gl.uniform1i(u.mode, 0); return; }

      const target = lut.is3D ? gl.TEXTURE_3D : gl.TEXTURE_2D;
      gl.activeTexture(lut.is3D ? gl.TEXTURE1 : gl.TEXTURE2);
      gl.bindTexture(target, lut.is3D ? lut3dTex : lut1dTex);
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
      gl.texParameteri(target, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(target, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(target, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(target, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      if (lut.is3D) gl.texParameteri(target, gl.TEXTURE_WRAP_R, gl.CLAMP_TO_EDGE);

      const N = lut.size;
      const attempts = [
        { name: 'half', internal: gl.RGB16F, type: gl.HALF_FLOAT, data: () => toHalfArray(lut.data) },
        { name: 'float', internal: gl.RGB32F, type: gl.FLOAT, data: () => lut.data, needs: 'OES_texture_float_linear' },
        { name: '8-bit', internal: gl.RGB8, type: gl.UNSIGNED_BYTE, data: () => Uint8Array.from(lut.data, (v) => Math.round(Math.max(0, Math.min(1, v)) * 255)) },
      ];
      precision = null;
      for (const a of attempts) {
        if (a.needs && !gl.getExtension(a.needs)) continue;
        while (gl.getError() !== gl.NO_ERROR) { /* clear stale errors */ }
        if (lut.is3D) gl.texImage3D(gl.TEXTURE_3D, 0, a.internal, N, N, N, 0, gl.RGB, a.type, a.data());
        else gl.texImage2D(gl.TEXTURE_2D, 0, a.internal, N, 1, 0, gl.RGB, a.type, a.data());
        if (gl.getError() === gl.NO_ERROR) { precision = a.name; break; }
      }
      if (!precision) throw new Error('The GPU rejected the LUT texture.');

      gl.uniform1f(u.size, N);
      gl.uniform3fv(u.dmin, lut.domainMin);
      gl.uniform3fv(u.dmax, lut.domainMax);
      gl.uniform1i(u.mode, enabled ? (lut.is3D ? 1 : 2) : 0);
      gl.activeTexture(gl.TEXTURE0);
    }

    function setEnabled(on) {
      enabled = !!on;
      gl.uniform1i(u.mode, enabled && current ? (current.is3D ? 1 : 2) : 0);
    }

    /** Draw the video's current frame through the LUT. */
    function draw(video) {
      const w = video.videoWidth, h = video.videoHeight;
      if (!w || !h || video.readyState < 2) return false;
      if (canvas.width !== w || canvas.height !== h) {
        canvas.width = w;
        canvas.height = h;
      }
      gl.viewport(0, 0, w, h);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, videoTex);
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
      try {
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, video);
      } catch (_) {
        return false;   // frame not yet decodable; try again on the next callback
      }
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
      return true;
    }

    function destroy() {
      try {
        gl.deleteTexture(videoTex); gl.deleteTexture(lut3dTex); gl.deleteTexture(lut1dTex);
        gl.deleteBuffer(quad); gl.deleteProgram(prog);
      } catch (_) { /* context may be gone */ }
    }

    return {
      setLUT, setEnabled, draw, destroy,
      get precision() { return precision; },
      get lut() { return current; },
      get enabled() { return enabled; },
    };
  }

  window.MaidenLUT = { parseCube, createRenderer };
})();
