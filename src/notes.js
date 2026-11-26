// Maiden's timeline notes use seconds and coordinates relative to the visible picture.
window.createPictureNotes = function ({ video, fps, tc, seek, duration }) {
  const el = id => document.getElementById('notes-' + id);
  const panel = el('panel'), frame = el('frame'), toggle = document.getElementById('btn-picture-notes');
  const canvas = frame.querySelector('canvas'), ctx = canvas.getContext('2d');
  const container = video.parentElement;
  const colors = { Amber: '#ffb800', Coral: '#fa7074', Green: '#46d882', Blue: '#39bafa', Pink: '#ef73b4', White: '#ffffff' };
  const fonts = { sans: 'sans-serif', serif: 'serif', mono: 'monospace', hand: 'cursive', display: 'fantasy' };
  let tool = 'pen', color = colors.Amber, notes = [], draft = null, live = null, pointer = null;
  let textInput = null, key = '', generation = 0, lastVisible = '', w = 0, h = 0;
  const atFrame = () => Math.max(0, Math.floor(video.currentTime * fps() + .001) / fps());
  const frameNow = () => Math.abs(atFrame() - draft.time) < .55 / fps();
  function button(parent, label, action) {
    const b = document.createElement('button');
    b.textContent = label;
    b.onclick = action;
    parent.append(b);
    return b;
  }
  function choose(parent, selected) {
    for (const b of parent.children) b.setAttribute('aria-pressed', String(b === selected));
  }
  for (const [kind, label, icon] of [['pen','Pen','✎'],['rect','Box','□'],['ellipse','Circle','○'],['arrow','Arrow','↗'],['text','Text','T']]) {
    const b = button(el('tools'), label, () => { tool = kind; choose(el('tools'), b); });
    const symbol = document.createElement('span');
    symbol.textContent = icon;
    symbol.ariaHidden = 'true';
    b.prepend(symbol);
    b.setAttribute('aria-pressed', String(kind === tool));
  }
  for (const [name, value] of Object.entries(colors)) {
    const b = button(el('colors'), '', () => { color = value; choose(el('colors'), b); });
    b.title = name;
    b.setAttribute('aria-label', name);
    b.setAttribute('aria-pressed', String(value === color));
    b.style.background = value;
  }

  function draw(i) {
    ctx.fillStyle = ctx.strokeStyle = i.color;
    ctx.lineWidth = Math.max(1, i.width * h);
    ctx.lineCap = ctx.lineJoin = 'round';
    ctx.beginPath();
    if (i.kind === 'text') {
      const label = document.createElement('span');
      label.textContent = i.text;
      positionText(label, i);
      el('labels').append(label);
    } else if (i.kind === 'pen') {
      const first = i.points[0];
      if (i.points.length === 1) {
        ctx.arc(first.x*w, first.y*h, ctx.lineWidth/2, 0, 2*Math.PI);
        ctx.fill();
      } else {
        ctx.moveTo(first.x*w, first.y*h);
        for (const p of i.points.slice(1)) ctx.lineTo(p.x*w, p.y*h);
        ctx.stroke();
      }
    } else {
      const x = i.a.x*w, y = i.a.y*h, dx = (i.b.x-i.a.x)*w, dy = (i.b.y-i.a.y)*h;
      if (i.kind === 'rect') ctx.rect(x,y,dx,dy);
      if (i.kind === 'ellipse') ctx.ellipse(x+dx/2,y+dy/2,Math.abs(dx/2),Math.abs(dy/2),0,0,2*Math.PI);
      if (i.kind === 'arrow') {
        const angle = Math.atan2(dy,dx), head = Math.max(8, ctx.lineWidth*4);
        ctx.moveTo(x,y); ctx.lineTo(x+dx,y+dy);
        for (const offset of [-Math.PI/6, Math.PI/6]) {
          ctx.moveTo(x+dx,y+dy);
          ctx.lineTo(x+dx-head*Math.cos(angle+offset),y+dy-head*Math.sin(angle+offset));
        }
      }
      ctx.stroke();
    }
  }
  function positionText(node, i) {
    Object.assign(node.style, { left: i.at.x*100+'%', top: i.at.y*100+'%', color: i.color,
      fontSize: Math.max(10,i.size*h)+'px', fontFamily: fonts[i.font] || fonts.sans });
  }
  function render(force = false, time = video.currentTime) {
    const enabled = !!key && el('visible').checked && !!video.videoWidth;
    const editing = !!(enabled && draft && video.paused && frameNow());
    frame.classList.toggle('drawing', editing);
    const showing = enabled ? notes.filter(n => n.id !== draft?.id && time+.00001 >= n.time && time+.00001 < n.time+n.duration) : [];
    if (editing) showing.push(draft);
    const signature = JSON.stringify(showing.map(n => n.id));
    if (!force && signature === lastVisible) return;
    lastVisible = signature;
    ctx.clearRect(0,0,w,h);
    el('cards').replaceChildren(); el('labels').replaceChildren();
    for (const n of showing) {
      n.items.forEach(draw);
      if (n.text.trim()) {
        const card = document.createElement('div');
        card.textContent = n.text; card.style.borderColor = n.color;
        el('cards').append(card);
      }
    }
    if (editing && live) draw(live);
    if (!editing && textInput) textInput.blur();
  }
  function resize() {
    const scale = Math.min(container.clientWidth/video.videoWidth, container.clientHeight/video.videoHeight);
    w = video.videoWidth ? Math.round(video.videoWidth*scale) : 0;
    h = video.videoHeight ? Math.round(video.videoHeight*scale) : 0;
    Object.assign(frame.style, { width: w+'px', height: h+'px', left: (container.clientWidth-w)/2+'px', top: (container.clientHeight-h)/2+'px' });
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.round(w*dpr); canvas.height = Math.round(h*dpr);
    ctx.setTransform(dpr,0,0,dpr,0,0);
    el('cards').style.fontSize = Math.max(11,h*.024)+'px';
    toggle.disabled = !key || !w;
    render(true);
  }
  new ResizeObserver(resize).observe(container);
  for (const event of ['loadedmetadata','resize','emptied']) video.addEventListener(event,resize);
  for (const event of ['timeupdate','seeked','pause','play']) video.addEventListener(event,() => render());
  if (video.requestVideoFrameCallback) {
    const tick = (_, meta) => { render(false, meta.mediaTime); video.requestVideoFrameCallback(tick); };
    video.requestVideoFrameCallback(tick);
  }
  function save(next) {
    try {
      localStorage.setItem(key, JSON.stringify({ visible: el('visible').checked, notes: next }));
      notes = next;
      return true;
    } catch {
      el('status').textContent = 'Could not save picture notes. Local storage may be full.';
      return false;
    }
  }
  function list() {
    el('list').replaceChildren();
    for (const n of [...notes].sort((a,b) => a.time-b.time)) {
      button(el('list'), tc(n.time)+'  '+(n.text.trim() || n.items.find(i=>i.kind==='text')?.text || 'Drawing'), () => edit(n));
    }
  }
  function finish() {
    textInput?.blur();
    draft = live = pointer = null;
    el('editor').hidden = true; el('new').hidden = false; el('list').hidden = false;
    el('status').textContent = '';
    list(); render(true);
  }
  function open(show) {
    if (!show) finish();
    panel.hidden = !show;
    document.getElementById('app').classList.toggle('notes-open',show);
    toggle.setAttribute('aria-expanded',String(show));
    if (show) list();
  }
  function edit(note) {
    video.pause();
    if (note) seek(note.time);
    draft = note ? structuredClone(note) : { id: crypto.randomUUID(), time: atFrame(), duration: 1/fps(), text: '', items: [], color, createdAt: new Date().toISOString() };
    el('new').hidden = el('list').hidden = true; el('editor').hidden = false;
    el('delete').hidden = !note;
    el('comment').value = draft.text;
    el('duration').value = Math.abs(draft.duration - 1/fps()) < .00001 ? 'frame' : [1,2,5].includes(draft.duration) ? String(draft.duration) : 'custom';
    el('custom-row').hidden = el('duration').value !== 'custom';
    el('custom').value = draft.duration;
    el('time').textContent = tc(draft.time);
    el('status').textContent = el('visible').checked ? '' : 'Turn on Show notes to draw on the picture.';
    render(true);
  }
  function setDuration() {
    const mode = el('duration').value;
    el('custom-row').hidden = mode !== 'custom';
    draft.duration = mode === 'end' ? Math.max(1/fps(),duration()-draft.time) : mode === 'frame' ? 1/fps() : Number(mode === 'custom' ? el('custom').value : mode);
  }
  el('new').onclick = () => edit(null);
  toggle.onclick = () => open(panel.hidden);
  el('close').onclick = () => open(false);
  el('cancel').onclick = finish;
  el('visible').onchange = () => {
    if (!save(notes)) el('visible').checked = !el('visible').checked;
    else el('status').textContent = '';
    render(true);
  };
  el('retime').onclick = () => { video.pause(); draft.time = atFrame(); el('time').textContent = tc(draft.time); setDuration(); render(true); };
  el('duration').onchange = el('custom').oninput = setDuration;
  el('comment').oninput = () => { draft.text = el('comment').value; render(true); };
  el('apply').onclick = () => {
    textInput?.blur();
    if (!(draft.duration > 0 && Number.isFinite(draft.duration)) || (!draft.text.trim() && !draft.items.length)) {
      el('status').textContent = 'Add a drawing or some text and choose a positive duration.'; return;
    }
    draft.updatedAt = new Date().toISOString();
    if (save([...notes.filter(n => n.id !== draft.id), draft])) finish();
  };
  el('delete').onclick = () => { if (save(notes.filter(n => n.id !== draft.id))) finish(); };
  el('undo').onclick = () => { draft.items.pop(); render(true); };
  panel.addEventListener('keydown', e => { e.stopPropagation(); if (e.key === 'Escape') open(false); });

  function point(e) {
    const r = frame.getBoundingClientRect();
    const clamp = n => Math.max(0,Math.min(1,n));
    return { x: clamp((e.clientX-r.left)/w), y: clamp((e.clientY-r.top)/h) };
  }
  function typeAt(at) {
    const i = { kind: 'text', at, color, size: .04, font: 'sans', text: '' };
    const input = document.createElement('textarea');
    textInput = input; input.maxLength = 2000; input.placeholder = 'Type on picture'; input.setAttribute('aria-label','Text on picture');
    positionText(input,i);
    input.onpointerdown = e => e.stopPropagation();
    input.onkeydown = e => {
      e.stopPropagation();
      if (e.key === 'Escape') { input.value = ''; input.blur(); }
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); input.blur(); }
    };
    input.onblur = () => { i.text = input.value.trim(); if (i.text && draft) draft.items.push(i); textInput = null; input.remove(); render(true); };
    frame.append(input); input.focus();
  }
  frame.onpointerdown = e => {
    if (!frame.classList.contains('drawing') || e.button !== 0 || pointer !== null) return;
    e.preventDefault(); textInput?.blur();
    const p = point(e);
    if (tool === 'text') return typeAt(p);
    pointer = e.pointerId; frame.setPointerCapture(pointer);
    const style = { kind: tool, color, width: Number(el('weight').value) };
    live = tool === 'pen' ? { ...style, points: [p] } : { ...style, a: p, b: p };
    render(true);
  };
  function extend(e) {
    const p = point(e);
    if (live.kind !== 'pen') live.b = p;
    else if (live.points.length < 4000) live.points.push(p);
  }
  frame.onpointermove = e => { if (pointer === e.pointerId && live) { extend(e); render(true); } };
  frame.onpointerup = e => {
    if (pointer !== e.pointerId || !live) return;
    if (live.kind !== 'pen') extend(e);
    if (draft && frame.classList.contains('drawing')) draft.items.push(live);
    live = pointer = null; render(true);
  };
  frame.onpointercancel = () => { live = pointer = null; render(true); };

  function validNote(n) {
    const pt = p => p && [p.x,p.y].every(v => Number.isFinite(v) && v >= 0 && v <= 1);
    return n && typeof n.id === 'string' && typeof n.text === 'string' && Number.isFinite(n.time) && n.time >= 0 &&
      Number.isFinite(n.duration) && n.duration > 0 && Array.isArray(n.items) && n.items.every(i => {
        if (!i || typeof i.color !== 'string') return false;
        if (i.kind === 'text') return pt(i.at) && typeof i.text === 'string' && Number.isFinite(i.size);
        if (!(Number.isFinite(i.width) && i.width > 0)) return false;
        return i.kind === 'pen' ? Array.isArray(i.points) && i.points.length && i.points.every(pt) :
          ['rect','ellipse','arrow'].includes(i.kind) && pt(i.a) && pt(i.b);
      });
  }
  return { async load(path) {
    const token = ++generation;
    open(false); notes = []; key = ''; resize();
    if (!path) return;
    let revision = 'local', imported = null, message = '';
    try {
      const result = await window.electronAPI.readPictureNotes(path);
      if (token !== generation) return;
      revision = result.revision;
      if (result.data) {
        imported = JSON.parse(result.data);
        if (imported?.version !== 1 || !Array.isArray(imported.notes) || !imported.notes.every(validNote)) throw new Error();
      }
    } catch { imported = null; message = 'Could not read the exported picture notes.'; }
    if (token !== generation) return;
    key = 'maiden.pictureNotes:' + JSON.stringify([path,revision]);
    let data = imported;
    try {
      const saved = JSON.parse(localStorage.getItem(key));
      if (saved && Array.isArray(saved.notes) && saved.notes.every(validNote)) data = saved;
    } catch { message = 'Could not read locally saved notes.'; }
    notes = data?.notes || []; el('visible').checked = data?.visible !== false;
    el('status').textContent = message; resize();
  } };
};
