/**
 * Playlist panel — renderer side.
 *
 * A panel that slides in from the left. The operator makes a playlist, names
 * it, adds footage from disk, and the player then runs through the list file
 * to file in the same window. Storage and thumbnails are in src/playlists.js.
 *
 * window.createPlaylist({ video, openFile, play }) →
 *   { toggle(), handleEnded() → boolean, mediaChanged() }
 */
window.createPlaylist = function createPlaylist({ video, openFile, play }) {
  const api = window.electronAPI;
  const app = document.getElementById('app');
  const panel = document.getElementById('playlist-panel');
  const el = (id) => document.getElementById('pl-' + id);
  const button = document.getElementById('btn-playlist');
  const LAST_KEY = 'maiden.playlist.last';

  let playlists = [];          // [{ file, name, count }]
  let current = null;          // { file, name, repeat, items: [{ path }] }
  let playing = -1;            // index of the entry now in the player, or -1
  let ours = 0;                // until when a media change is the playlist's own doing
  let playToken = 0;
  let saveTimer = null;
  let dragFrom = -1;
  const info = new Map();      // path → { name, duration, thumb, missing, kind }
  const wanted = [];           // paths still to be looked up
  let looking = false;

  const remember = (file) => { try { localStorage.setItem(LAST_KEY, file || ''); } catch (_) { /* private mode */ } };
  const recall = () => { try { return localStorage.getItem(LAST_KEY) || ''; } catch (_) { return ''; } };
  const status = (text) => { el('status').textContent = text || ''; };

  function clock(seconds) {
    if (!(seconds > 0)) return '';
    const s = Math.round(seconds);
    const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), r = s % 60;
    const two = (n) => String(n).padStart(2, '0');
    return h ? h + ':' + two(m) + ':' + two(r) : m + ':' + two(r);
  }

  const baseName = (p) => String(p).split(/[\\/]/).filter(Boolean).pop() || String(p);

  // ── Looking entries up, one at a time so a long list does not start a
  //    hundred ffmpegs at once ───────────────────────────────────────────────
  function lookUp(paths) {
    for (const p of paths) if (!info.has(p) && !wanted.includes(p)) wanted.push(p);
    if (looking) return;
    looking = true;
    (async () => {
      while (wanted.length) {
        const p = wanted.shift();
        try { info.set(p, await api.playlistItemInfo(p)); } catch (_) { info.set(p, { name: baseName(p), duration: 0, thumb: null, missing: false }); }
        renderItems();
      }
      looking = false;
    })();
  }

  // ── Drawing ───────────────────────────────────────────────────────────────
  function renderSelect() {
    const select = el('select');
    select.innerHTML = '';
    for (const p of playlists) {
      const option = document.createElement('option');
      option.value = p.file;
      option.textContent = p.name + ' (' + p.count + ')';
      select.appendChild(option);
    }
    if (current) select.value = current.file;
    const has = !!current;
    select.disabled = !playlists.length;
    for (const id of ['name', 'delete', 'add', 'add-folder', 'repeat']) el(id).disabled = !has;
    el('name').value = has ? current.name : '';
    el('repeat').checked = has && current.repeat;
  }

  function renderItems() {
    const list = el('list');
    const items = current ? current.items : [];
    list.innerHTML = '';
    if (!items.length) {
      const empty = document.createElement('div');
      empty.id = 'pl-empty';
      empty.textContent = current
        ? 'This playlist is empty. Add files, or drop footage here.'
        : 'No playlists yet. Choose New to make one, then add your footage.';
      list.appendChild(empty);
    }
    let total = 0;
    items.forEach((item, i) => {
      const meta = info.get(item.path);
      if (meta && meta.duration) total += meta.duration;
      const row = document.createElement('div');
      row.className = 'pl-item' + (i === playing ? ' playing' : '') + (meta && meta.missing ? ' missing' : '');
      row.draggable = true;
      row.dataset.index = String(i);
      row.title = item.path;

      const num = document.createElement('div');
      num.className = 'pl-num';
      num.textContent = String(i + 1);
      const thumb = document.createElement('div');
      thumb.className = 'pl-thumb';
      if (meta && meta.thumb) thumb.style.backgroundImage = 'url("' + meta.thumb + '")';
      else thumb.textContent = !meta ? '…' : meta.missing ? 'Missing' : meta.kind === 'dcp' ? 'DCP' : 'No picture';
      const text = document.createElement('div');
      text.className = 'pl-text';
      const name = document.createElement('div');
      name.className = 'pl-name';
      name.textContent = (meta && meta.name) || baseName(item.path);
      const sub = document.createElement('div');
      sub.className = 'pl-meta';
      sub.textContent = meta && meta.missing ? 'File not found' : (meta && clock(meta.duration)) || '';
      text.append(name, sub);
      const remove = document.createElement('button');
      remove.className = 'pl-remove';
      remove.textContent = '×';
      remove.title = 'Remove from playlist';
      remove.setAttribute('aria-label', 'Remove ' + name.textContent + ' from playlist');
      row.append(num, thumb, text, remove);
      list.appendChild(row);
    });
    el('play').disabled = !items.length;
    el('prev').disabled = el('next').disabled = items.length < 2 && playing < 0;
    el('count').textContent = items.length
      ? items.length + (items.length === 1 ? ' clip' : ' clips') + (total ? ' · ' + clock(total) : '')
      : '';
  }

  function render() { renderSelect(); renderItems(); }

  // ── Storage ───────────────────────────────────────────────────────────────
  async function refresh() {
    try { playlists = await api.playlistList(); } catch (_) { playlists = []; }
    if (!current && playlists.length) {
      const last = recall();
      await choose((playlists.find((p) => p.file === last) || playlists[0]).file);
      return;
    }
    render();
  }

  async function choose(file) {
    const loaded = await api.playlistLoad(file);
    if (!loaded || loaded.error) {
      status((loaded && loaded.error) || 'That playlist could not be opened.');
      current = null;
    } else {
      current = loaded;
      remember(current.file);
      status('');
      lookUp(current.items.map((i) => i.path));
    }
    playing = -1;
    render();
  }

  async function saveNow() {
    clearTimeout(saveTimer);
    saveTimer = null;
    if (!current) return;
    try {
      const saved = await api.playlistSave({ file: current.file, name: current.name, repeat: current.repeat, items: current.items });
      if (saved && saved.error) { status('Could not save the playlist: ' + saved.error); return; }
      current.file = saved.file;
      current.name = saved.name;
      remember(current.file);
      playlists = await api.playlistList();
      renderSelect();
    } catch (err) {
      status('Could not save the playlist: ' + err.message);
    }
  }
  function saveSoon() { clearTimeout(saveTimer); saveTimer = setTimeout(saveNow, 400); }

  function addPaths(paths) {
    if (!current || !paths || !paths.length) return;
    for (const p of paths) current.items.push({ path: p });
    lookUp(paths);
    renderItems();
    saveSoon();
    status('Added ' + paths.length + (paths.length === 1 ? ' clip.' : ' clips.'));
  }

  // ── Playing through the list ──────────────────────────────────────────────
  async function playAt(index, tries) {
    if (!current || !current.items.length) return;
    const count = current.items.length;
    const i = ((index % count) + count) % count;
    const item = current.items[i];
    const token = ++playToken;

    let meta = info.get(item.path);
    if (!meta || meta.missing) {
      try { meta = await api.playlistItemInfo(item.path); info.set(item.path, meta); } catch (_) { /* play it anyway */ }
      if (token !== playToken) return;
    }
    if (meta && meta.missing) {
      // Step over a file that has gone, but never spin through a list of them.
      renderItems();
      if ((tries || 0) + 1 >= count) { status('None of the files in this playlist could be found.'); playing = -1; renderItems(); return; }
      status('Skipped a missing file: ' + baseName(item.path));
      return playAt(i + 1, (tries || 0) + 1);
    }

    playing = i;
    ours = Date.now() + 15000;
    renderItems();
    const row = el('list').querySelector('.pl-item.playing');
    if (row) row.scrollIntoView({ block: 'nearest' });
    status('');

    // Ordinary files open parked on their first frame; a playlist runs.
    const start = () => { if (token === playToken && (video.paused || video.ended) && video.readyState >= 2) play(); };
    const onReady = () => start();
    video.addEventListener('canplay', onReady);
    setTimeout(() => video.removeEventListener('canplay', onReady), 20000);
    try {
      await openFile(item.path);
    } catch (err) {
      status('Could not open ' + baseName(item.path) + ': ' + err.message);
    }
    start();
  }

  /** The clip finished. → true when the playlist took it from there. */
  function handleEnded() {
    if (!current || playing < 0) return false;
    const next = playing + 1;
    if (next >= current.items.length && !current.repeat) return false;
    playAt(next);
    return true;
  }

  /** Something else was opened by hand: the playlist is no longer in charge. */
  function mediaChanged() {
    if (playing >= 0 && Date.now() > ours) { playing = -1; renderItems(); }
  }

  // ── The panel itself ──────────────────────────────────────────────────────
  function open(show) {
    app.classList.toggle('playlist-open', show);
    panel.setAttribute('aria-hidden', show ? 'false' : 'true');
    if (button) button.setAttribute('aria-expanded', show ? 'true' : 'false');
    if (show) refresh();
    // Overlays drawn over the picture measure it; tell them it moved.
    setTimeout(() => window.dispatchEvent(new Event('resize')), 270);
  }
  const toggle = () => open(!app.classList.contains('playlist-open'));

  if (button) button.onclick = toggle;
  el('close').onclick = () => open(false);
  el('select').onchange = async () => { await saveNow(); choose(el('select').value); };
  el('new').onclick = async () => {
    await saveNow();
    const taken = new Set(playlists.map((p) => p.name.toLowerCase()));
    let n = playlists.length + 1;
    while (taken.has(('Playlist ' + n).toLowerCase())) n++;
    current = { file: null, name: 'Playlist ' + n, repeat: false, items: [] };
    playing = -1;
    await saveNow();
    render();
    el('name').focus();
    el('name').select();
  };
  el('name').onchange = () => {
    if (!current) return;
    const name = el('name').value.trim();
    if (!name) { el('name').value = current.name; return; }
    current.name = name;
    saveNow();
  };
  el('name').onkeydown = (e) => { e.stopPropagation(); if (e.key === 'Enter') el('name').blur(); };
  el('delete').onclick = async () => {
    if (!current) return;
    if (!confirm('Delete the playlist "' + current.name + '"?\n\nThe media files themselves are not touched.')) return;
    clearTimeout(saveTimer);
    if (current.file) await api.playlistDelete(current.file);
    current = null;
    playing = -1;
    remember('');
    await refresh();
  };
  el('repeat').onchange = () => { if (current) { current.repeat = el('repeat').checked; saveSoon(); } };
  el('add').onclick = async () => addPaths(await api.playlistAddFiles());
  el('add-folder').onclick = async () => addPaths(await api.playlistAddFolder());
  el('folder').onclick = () => api.playlistOpenFolder();
  el('play').onclick = () => playAt(playing >= 0 ? playing : 0);
  el('prev').onclick = () => playAt((playing < 0 ? 0 : playing) - 1);
  el('next').onclick = () => playAt(playing + 1);

  const list = el('list');
  list.addEventListener('click', (e) => {
    const row = e.target.closest('.pl-item');
    if (!row || !current) return;
    const i = Number(row.dataset.index);
    if (e.target.closest('.pl-remove')) {
      current.items.splice(i, 1);
      if (i === playing) playing = -1; else if (i < playing) playing--;
      renderItems();
      saveSoon();
      return;
    }
    playAt(i);
  });

  // Reordering by drag, and footage dropped in from the desktop.
  const clearMarks = () => list.querySelectorAll('.drop-above, .drop-below, .dragging').forEach((n) => n.classList.remove('drop-above', 'drop-below', 'dragging'));
  list.addEventListener('dragstart', (e) => {
    const row = e.target.closest('.pl-item');
    if (!row) return;
    dragFrom = Number(row.dataset.index);
    row.classList.add('dragging');
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', 'playlist-item');
  });
  list.addEventListener('dragend', () => { dragFrom = -1; clearMarks(); });
  panel.addEventListener('dragover', (e) => {
    e.preventDefault();
    if (dragFrom < 0) return;
    const row = e.target.closest && e.target.closest('.pl-item');
    list.querySelectorAll('.drop-above, .drop-below').forEach((n) => n.classList.remove('drop-above', 'drop-below'));
    if (!row) return;
    const box = row.getBoundingClientRect();
    row.classList.add(e.clientY < box.top + box.height / 2 ? 'drop-above' : 'drop-below');
  });
  panel.addEventListener('drop', (e) => {
    e.preventDefault();
    if (!current) { clearMarks(); status('Make a playlist first, then drop footage on it.'); return; }
    if (dragFrom >= 0) {
      const row = e.target.closest && e.target.closest('.pl-item');
      if (row) {
        const box = row.getBoundingClientRect();
        let to = Number(row.dataset.index) + (e.clientY < box.top + box.height / 2 ? 0 : 1);
        const from = dragFrom;
        if (to > from) to--;
        if (to !== from) {
          const nowPlaying = playing >= 0 ? current.items[playing] : null;
          const [moved] = current.items.splice(from, 1);
          current.items.splice(to, 0, moved);
          playing = nowPlaying ? current.items.indexOf(nowPlaying) : -1;
          saveSoon();
        }
      }
      dragFrom = -1;
      clearMarks();
      renderItems();
      return;
    }
    const paths = Array.from(e.dataTransfer.files || []).map((f) => f.path).filter(Boolean);
    addPaths(paths);
  });

  render();
  return { toggle, handleEnded, mediaChanged };
};
