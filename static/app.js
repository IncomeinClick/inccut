"use strict";

const $ = (sel) => document.querySelector(sel);

const state = {
  projectId: null,
  projectName: "",
  videos: [],          // [{video_id, filename, duration, width, height, has_audio}]
  peaksByVideo: {},    // {video_id: peaks_array}
  peaksScale: {},      // {video_id: 1/maxAbsPeak — for waveform normalization}
  canvas: { w: 1080, h: 1920 },  // output frame size; per-clip pos/scale render into this
  clips: [],           // [{id, video_id, src_start, src_end, pos_x, pos_y, scale}]
  selectedClipId: null,
  nextClipId: 1,
  audios: [],          // [{audio_id, filename, ext, duration}]
  peaksByAudio: {},    // {audio_id: peaks_array}
  peaksScaleByAudio: {}, // {audio_id: scale}
  musicClips: [],      // [{id, audio_id, src_start, src_end, volume}]
  selectedMusicId: null,
  nextMusicId: 1,
  isPlaying: false,
  dirty: false,
  history: [],
  future: [],
  clipboard: null,
  savedHash: null,
  loadedVideoId: null, // currently in <video> element
  activeClipIdx: 0,    // which clip we're currently playing/seeked to
  zoom: 1.0,
};

// audio_id → HTMLAudioElement (one persistent element per source audio)
const audioEls = {};

function getOrCreateAudioEl(audio_id) {
  if (audioEls[audio_id]) return audioEls[audio_id];
  const a = new Audio(`/api/audio/${audio_id}`);
  a.preload = "auto";
  audioEls[audio_id] = a;
  return a;
}

function musicEditRanges() {
  // Sequential placement starting at edit time 0. Returns [{clip, edit_start, edit_end}]
  const out = [];
  let acc = 0;
  for (const mc of state.musicClips) {
    const dur = Math.max(0, mc.src_end - mc.src_start);
    out.push({ clip: mc, edit_start: acc, edit_end: acc + dur });
    acc += dur;
  }
  return out;
}

function syncMusicToEdit(editTime, wantPlaying) {
  const ranges = musicEditRanges();
  for (const r of ranges) {
    const el = getOrCreateAudioEl(r.clip.audio_id);
    const inside = editTime >= r.edit_start && editTime < r.edit_end;
    if (inside) {
      const targetSrc = r.clip.src_start + (editTime - r.edit_start);
      if (Math.abs(el.currentTime - targetSrc) > 0.15) {
        try { el.currentTime = targetSrc; } catch (_) {}
      }
      el.volume = Math.max(0, Math.min(1, r.clip.volume));
      if (wantPlaying) {
        if (el.paused) el.play().catch(() => {});
      } else {
        if (!el.paused) el.pause();
      }
    } else {
      if (!el.paused) el.pause();
    }
  }
}

function stopAllMusic() {
  for (const id in audioEls) {
    const el = audioEls[id];
    if (!el.paused) el.pause();
  }
}

function refreshActiveClip() {
  const m = editToSrc(currentEditTime);
  state.activeClipIdx = m ? state.clips.indexOf(m.clip) : 0;
  if (state.activeClipIdx < 0) state.activeClipIdx = 0;
  applyStage();
}

// ---------- Dual <video> management ----------

const videoEls = { A: null, B: null };
let activeKey = "A";
let bufferLoadedFor = null; // { video_id, src_start } or null

function activeVideoEl() { return videoEls[activeKey]; }
function bufferVideoEl() { return videoEls[activeKey === "A" ? "B" : "A"]; }

function setActiveVideoVisible() {
  const a = activeVideoEl();
  const b = bufferVideoEl();
  a.classList.remove("buffer");
  b.classList.add("buffer");
  applyStage();
}

function ensureNextVideoBuffered() {
  // If next clip's video is different from active's, pre-load it into the buffer element.
  const next = state.clips[state.activeClipIdx + 1];
  if (!next) return;
  if (next.video_id === state.loadedVideoId) return;
  if (bufferLoadedFor && bufferLoadedFor.video_id === next.video_id) return;

  const buf = bufferVideoEl();
  buf.pause();
  buf.src = `/api/preview/${next.video_id}.mp4`;
  bufferLoadedFor = { video_id: next.video_id, src_start: next.src_start };
  const onMeta = () => {
    buf.removeEventListener("loadedmetadata", onMeta);
    try { buf.currentTime = next.src_start; } catch (_) {}
  };
  buf.addEventListener("loadedmetadata", onMeta);
}

function swapToBufferAt(srcTime) {
  const oldActive = activeVideoEl();
  const wasPlaying = !oldActive.paused;
  activeKey = activeKey === "A" ? "B" : "A";
  const newActive = activeVideoEl();
  try { newActive.currentTime = srcTime; } catch (_) {}
  setActiveVideoVisible();
  oldActive.pause();
  state.loadedVideoId = bufferLoadedFor.video_id;
  bufferLoadedFor = null;
  if (wasPlaying) newActive.play();
}

const ZOOM_MIN = 1;
const ZOOM_MAX = 50;

function applyZoom() {
  $("#timeline-content").style.width = (state.zoom * 100) + "%";
  $("#zoom-display").textContent = `${(state.zoom * 100).toFixed(0)}%`;
  $("#zoom-out").disabled = state.zoom <= ZOOM_MIN + 0.001;
  $("#zoom-in").disabled = state.zoom >= ZOOM_MAX - 0.001;
  requestAnimationFrame(redrawWaveforms);
}

function setZoom(newZoom, anchorEditTime = null) {
  newZoom = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, newZoom));
  if (Math.abs(newZoom - state.zoom) < 0.001) return;
  const scroll = $("#timeline-scroll");
  // Anchor: keep the given edit time at the same screen x position.
  const anchor = anchorEditTime ?? currentEditTime;
  const total = editDuration();
  const oldContentW = $("#timeline-content").clientWidth;
  const anchorPct = total > 0 ? anchor / total : 0;
  const oldAnchorPx = anchorPct * oldContentW;
  const oldScreenX = oldAnchorPx - scroll.scrollLeft;

  state.zoom = newZoom;
  applyZoom();

  const newContentW = $("#timeline-content").clientWidth;
  const newAnchorPx = anchorPct * newContentW;
  scroll.scrollLeft = Math.max(0, newAnchorPx - oldScreenX);
}

function computePeaksScale(peaks) {
  let maxAbs = 0;
  for (const p of peaks) {
    const a = Math.abs(p[0]);
    const b = Math.abs(p[1]);
    if (a > maxAbs) maxAbs = a;
    if (b > maxAbs) maxAbs = b;
  }
  return maxAbs > 0.01 ? (0.95 / maxAbs) : 1;
}

// Stable color palette per video index — first 8 then cycle
const VIDEO_COLORS = ["#0ea5e9", "#a78bfa", "#f59e0b", "#10b981", "#ec4899", "#f97316", "#6366f1", "#22d3ee"];

function videoColor(video_id) {
  const idx = state.videos.findIndex((v) => v.video_id === video_id);
  return VIDEO_COLORS[idx % VIDEO_COLORS.length] || VIDEO_COLORS[0];
}

function getVideo(video_id) {
  return state.videos.find((v) => v.video_id === video_id);
}

const HISTORY_LIMIT = 200;

function clipsHash(clips) {
  return JSON.stringify([
    clips.map((c) => [c.video_id, c.src_start, c.src_end, c.pos_x, c.pos_y, c.scale]),
    state.musicClips.map((m) => [m.audio_id, m.src_start, m.src_end, m.volume]),
    [state.canvas.w, state.canvas.h],
  ]);
}

function snapshot() {
  return {
    canvas: { ...state.canvas },
    clips: state.clips.map((c) => ({ ...c })),
    musicClips: state.musicClips.map((m) => ({ ...m })),
    selectedClipId: state.selectedClipId,
    selectedMusicId: state.selectedMusicId,
  };
}

function pushHistory() {
  state.history.push(snapshot());
  if (state.history.length > HISTORY_LIMIT) state.history.shift();
  state.future = [];
}

function applySnapshot(s) {
  if (s.canvas) state.canvas = { ...s.canvas };
  state.clips = s.clips.map((c) => ({ ...c }));
  state.musicClips = (s.musicClips || []).map((m) => ({ ...m }));
  state.selectedClipId = s.selectedClipId;
  state.selectedMusicId = s.selectedMusicId ?? null;
  // Make sure nextClipId stays beyond existing ids
  for (const c of state.clips) {
    if (c.id >= state.nextClipId) state.nextClipId = c.id + 1;
  }
  for (const m of state.musicClips) {
    if (m.id >= state.nextMusicId) state.nextMusicId = m.id + 1;
  }
  refreshDirty();
  // Re-seek video to a valid spot in the new clip arrangement
  const total = editDuration();
  if (currentEditTime > total) currentEditTime = Math.max(0, total - 0.1);
  seekToEdit(currentEditTime);
  renderTimeline();
}

function undo() {
  if (!state.history.length) return;
  state.future.push(snapshot());
  applySnapshot(state.history.pop());
}

function redo() {
  if (!state.future.length) return;
  state.history.push(snapshot());
  applySnapshot(state.future.pop());
}

function refreshDirty() {
  const isDirty = state.savedHash !== null && clipsHash(state.clips) !== state.savedHash;
  setDirty(isDirty);
}

let currentEditTime = 0;

// ---------- Helpers ----------

function fmt(t) {
  if (!isFinite(t) || t < 0) t = 0;
  const m = Math.floor(t / 60);
  const s = Math.floor(t % 60);
  return `${m}:${String(s).padStart(2, "0")}`;
}

function fmtSize(b) {
  if (b > 1024 * 1024 * 1024) return (b / 1024 / 1024 / 1024).toFixed(2) + " GB";
  if (b > 1024 * 1024) return (b / 1024 / 1024).toFixed(0) + " MB";
  return Math.round(b / 1024) + " KB";
}

function editDuration() {
  const videoTotal = state.clips.reduce((s, c) => s + (c.src_end - c.src_start), 0);
  if (videoTotal > 0) return videoTotal;
  // Audio-only project: timeline runs the length of the music.
  return state.musicClips.reduce((s, m) => s + (m.src_end - m.src_start), 0);
}

function isAudioOnly() {
  return state.clips.length === 0 && state.musicClips.length > 0;
}

function clipOffset(target) {
  let acc = 0;
  for (const c of state.clips) {
    if (c === target) return acc;
    acc += c.src_end - c.src_start;
  }
  return acc;
}

function findClipBySrcTime(t, video_id) {
  for (const c of state.clips) {
    if (c.video_id === video_id && t >= c.src_start && t < c.src_end) return c;
  }
  return null;
}

function editToSrc(editTime) {
  let acc = 0;
  for (const c of state.clips) {
    const dur = c.src_end - c.src_start;
    if (editTime <= acc + dur) {
      return { clip: c, srcTime: c.src_start + Math.max(0, editTime - acc) };
    }
    acc += dur;
  }
  if (state.clips.length > 0) {
    const last = state.clips[state.clips.length - 1];
    return { clip: last, srcTime: last.src_end };
  }
  return null;
}

function setDirty(d) {
  state.dirty = d;
  const btn = $("#save-btn");
  const status = $("#save-status");
  if (state.projectId) {
    btn.hidden = false;
    btn.disabled = !d;
    btn.textContent = d ? "💾 Save" : "✓ Saved";
    status.hidden = true;
  }
}

// ---------- Screens ----------

function showScreen(name) {
  $("#home-screen").hidden = name !== "home";
  $("#upload-screen").hidden = name !== "upload";
  $("#editor").hidden = name !== "editor";

  $("#save-btn").hidden = name !== "editor" || !state.projectId;
  $("#back-btn").hidden = name === "home";
  if (name === "home") $("#filename").textContent = "";
}

function goHome() {
  if (state.dirty && !confirm("ยังไม่ได้บันทึก ออกเลยไหม?")) return;
  state.projectId = null;
  state.clips = [];
  state.dirty = false;
  if (videoEls.A) videoEls.A.src = "";
  if (videoEls.B) videoEls.B.src = "";
  state.loadedVideoId = null;
  bufferLoadedFor = null;
  showScreen("home");
  loadProjects();
}

// ---------- Home / projects list ----------

async function loadProjects() {
  const grid = $("#projects-grid");
  // Remove all cards except the +new tile
  for (const c of [...grid.querySelectorAll(".project-card:not(.new-card)")]) c.remove();

  const res = await fetch("/api/projects");
  const projects = await res.json();
  $("#projects-empty").hidden = projects.length > 0;

  for (const p of projects) {
    const card = document.createElement("div");
    card.className = "project-card";

    const thumb = document.createElement("div");
    thumb.className = "thumb";
    thumb.style.backgroundImage = `url(/api/thumbnail/${p.video_id}.jpg)`;
    card.appendChild(thumb);

    const body = document.createElement("div");
    body.className = "body";
    const name = document.createElement("div");
    name.className = "name";
    name.textContent = p.name;
    const meta = document.createElement("div");
    meta.className = "meta";
    const updated = p.updated_at ? new Date(p.updated_at).toLocaleString("th-TH", { dateStyle: "short", timeStyle: "short" }) : "";
    meta.textContent = `${fmt(p.duration)}${updated ? " · " + updated : ""}`;
    body.appendChild(name);
    body.appendChild(meta);
    card.appendChild(body);

    const menuBtn = document.createElement("button");
    menuBtn.className = "menu-btn";
    menuBtn.textContent = "⋯";
    menuBtn.onclick = (e) => {
      e.stopPropagation();
      showCardMenu(menuBtn, p);
    };
    card.appendChild(menuBtn);

    card.onclick = () => openProject(p.id);
    grid.appendChild(card);
  }
}

function showCardMenu(anchor, project) {
  closeCardMenu();
  const menu = document.createElement("div");
  menu.className = "card-menu";
  menu.id = "card-menu";

  const renameBtn = document.createElement("button");
  renameBtn.textContent = "✏ เปลี่ยนชื่อ";
  renameBtn.onclick = (e) => {
    e.stopPropagation();
    closeCardMenu();
    promptRename(project);
  };

  const deleteBtn = document.createElement("button");
  deleteBtn.className = "danger";
  deleteBtn.textContent = "🗑 ลบโปรเจกต์";
  deleteBtn.onclick = async (e) => {
    e.stopPropagation();
    closeCardMenu();
    if (!confirm(`ลบโปรเจกต์ "${project.name}"?`)) return;
    await fetch(`/api/projects/${project.id}`, { method: "DELETE" });
    loadProjects();
  };

  menu.appendChild(renameBtn);
  menu.appendChild(deleteBtn);

  const rect = anchor.getBoundingClientRect();
  menu.style.top = rect.bottom + 4 + "px";
  menu.style.left = (rect.right - 140) + "px";
  document.body.appendChild(menu);
  setTimeout(() => document.addEventListener("click", closeCardMenu, { once: true }), 0);
}

function closeCardMenu() {
  const m = document.getElementById("card-menu");
  if (m) m.remove();
}

function promptRename(project) {
  const modal = $("#rename-modal");
  const input = $("#rename-input");
  input.value = project.name;
  modal.hidden = false;
  setTimeout(() => input.focus(), 0);

  $("#rename-cancel").onclick = () => { modal.hidden = true; };
  $("#rename-go").onclick = async () => {
    const name = input.value.trim();
    if (!name) return;
    await fetch(`/api/projects/${project.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name }),
    });
    modal.hidden = true;
    loadProjects();
  };
}

async function openProject(pid) {
  const res = await fetch(`/api/projects/${pid}`);
  if (!res.ok) { alert("โหลดโปรเจกต์ผิดพลาด"); return; }
  const proj = await res.json();
  await loadIntoEditor(proj);
}

async function loadIntoEditor(proj) {
  state.projectId = proj.id;
  state.projectName = proj.name;
  state.videos = proj.videos || [];
  state.audios = proj.audios || [];

  // Fetch peaks for each video + audio in parallel
  state.peaksByVideo = {};
  state.peaksScale = {};
  state.peaksByAudio = {};
  state.peaksScaleByAudio = {};
  await Promise.all([
    ...state.videos.map(async (v) => {
      const r = await fetch(`/api/peaks/${v.video_id}`);
      const peaks = await r.json();
      state.peaksByVideo[v.video_id] = peaks;
      state.peaksScale[v.video_id] = computePeaksScale(peaks);
    }),
    ...state.audios.map(async (a) => {
      const r = await fetch(`/api/peaks/${a.audio_id}`);
      const peaks = await r.json();
      state.peaksByAudio[a.audio_id] = peaks;
      state.peaksScaleByAudio[a.audio_id] = computePeaksScale(peaks);
    }),
  ]);

  state.canvas = {
    w: (proj.canvas && proj.canvas.w) || 1080,
    h: (proj.canvas && proj.canvas.h) || 1920,
  };
  state.clips = proj.clips.map((c) => ({
    id: state.nextClipId++,
    video_id: c.video_id,
    src_start: c.src_start,
    src_end: c.src_end,
    pos_x: c.pos_x ?? 0.5,
    pos_y: c.pos_y ?? 0.5,
    scale: c.scale ?? 1.0,
  }));
  state.musicClips = (proj.music_clips || []).map((m) => ({
    id: state.nextMusicId++,
    audio_id: m.audio_id,
    src_start: m.src_start,
    src_end: m.src_end,
    volume: m.volume ?? 0.3,
  }));
  state.selectedClipId = null;
  state.selectedMusicId = null;
  state.activeClipIdx = 0;
  state.zoom = 1.0;
  currentEditTime = 0;

  // Init video element refs (idempotent) and load first clip's video into active
  if (!videoEls.A) {
    videoEls.A = document.getElementById("video");
    videoEls.B = document.getElementById("video-buffer");
  }
  activeKey = "A";
  setActiveVideoVisible();
  videoEls.B.src = "";
  bufferLoadedFor = null;
  state.loadedVideoId = null;
  if (state.clips.length > 0) {
    await ensureVideoLoaded(state.clips[0].video_id, state.clips[0].src_start);
    ensureNextVideoBuffered();
  } else {
    videoEls.A.src = "";
  }

  $("#filename").textContent = proj.name;
  showScreen("editor");
  setupEditor();
  setupCanvasControls();
  // Sync canvas controls now that state.canvas is set.
  document.getElementById("canvas-w").value = state.canvas.w;
  document.getElementById("canvas-h").value = state.canvas.h;
  applyStage();
  state.history = [];
  state.future = [];
  state.savedHash = clipsHash(state.clips);
  setDirty(false);
  renderTimeline();
}

function ensureVideoLoaded(video_id, srcTime = 0) {
  // Active already has it — just seek
  if (state.loadedVideoId === video_id) {
    try { activeVideoEl().currentTime = srcTime; } catch (_) {}
    return Promise.resolve();
  }
  // Buffer has it — atomic swap (fast)
  if (bufferLoadedFor && bufferLoadedFor.video_id === video_id) {
    swapToBufferAt(srcTime);
    return Promise.resolve();
  }
  // Cold load into active
  const v = activeVideoEl();
  state.loadedVideoId = video_id;
  v.src = `/api/preview/${video_id}.mp4`;
  return new Promise((res) => {
    const onMeta = () => {
      v.removeEventListener("loadedmetadata", onMeta);
      try { v.currentTime = srcTime; } catch (_) {}
      res();
    };
    v.addEventListener("loadedmetadata", onMeta);
  });
}

// ---------- Upload ----------

function setupUpload() {
  const input = $("#file-input");
  const dz = $("#dropzone");

  input.addEventListener("change", () => {
    if (input.files.length) startUpload(input.files[0]);
  });

  dz.addEventListener("dragover", (e) => {
    e.preventDefault();
    dz.classList.add("drag-over");
  });
  dz.addEventListener("dragleave", () => dz.classList.remove("drag-over"));
  dz.addEventListener("drop", (e) => {
    e.preventDefault();
    dz.classList.remove("drag-over");
    if (e.dataTransfer.files.length) startUpload(e.dataTransfer.files[0]);
  });
}

function startUpload(file) {
  $("#dropzone").hidden = true;
  $("#upload-progress").hidden = false;
  const fill = $("#upload-progress .progress-fill");
  const label = $("#progress-label");

  const fd = new FormData();
  fd.append("file", file);

  const xhr = new XMLHttpRequest();
  xhr.upload.onprogress = (e) => {
    if (!e.lengthComputable) return;
    const pct = (e.loaded / e.total) * 100;
    fill.style.width = pct + "%";
    label.textContent = `อัปโหลด ${pct.toFixed(0)}% (${fmtSize(e.loaded)} / ${fmtSize(e.total)})`;
  };
  xhr.upload.onloadend = () => {
    fill.style.width = "100%";
    label.textContent = "กำลังประมวลผล... (สร้าง waveform — อาจใช้เวลา 1-2 นาทีสำหรับไฟล์ยาว 30 นาที)";
  };
  xhr.onload = async () => {
    if (xhr.status === 200) {
      try {
        const data = JSON.parse(xhr.responseText);
        // Fetch the full normalized project (with videos[] array + peaks paths)
        // instead of constructing the old single-video shape inline.
        await openProject(data.project_id);
      } catch (e) {
        alert("Parse error: " + e.message);
        resetUpload();
      }
    } else {
      alert("Upload failed: " + (xhr.responseText || xhr.statusText));
      resetUpload();
    }
  };
  xhr.onerror = () => {
    alert("Upload failed (network)");
    resetUpload();
  };
  xhr.open("POST", "/api/upload");
  xhr.send(fd);
}

function resetUpload() {
  $("#dropzone").hidden = false;
  $("#upload-progress").hidden = true;
  $("#upload-progress .progress-fill").style.width = "0%";
  $("#file-input").value = "";
}

// ---------- Editor ----------

let editorReady = false;

// ---------- Canvas + per-clip transform ----------

function activeClip() {
  return state.clips[state.activeClipIdx] || null;
}

function videoNativeDims(video_id) {
  const v = getVideo(video_id);
  if (v && v.width && v.height) return { w: v.width, h: v.height };
  // Fallback: use the loaded video element's intrinsic dims.
  const el = activeVideoEl();
  if (el && el.videoWidth && el.videoHeight) {
    return { w: el.videoWidth, h: el.videoHeight };
  }
  return { w: state.canvas.w, h: state.canvas.h };
}

function applyStage() {
  const stage = document.getElementById("stage");
  if (!stage) return;
  // Size the stage to canvas aspect, fitting within wrapper.
  stage.style.aspectRatio = `${state.canvas.w} / ${state.canvas.h}`;
  // Decide whether width or height should max out, based on wrap.
  const wrap = stage.parentElement;
  if (wrap) {
    const wrapW = wrap.clientWidth;
    const wrapH = wrap.clientHeight;
    if (wrapW / wrapH > state.canvas.w / state.canvas.h) {
      // wrapper wider than canvas ratio → height-bound
      stage.style.height = "96%";
      stage.style.width = "auto";
    } else {
      stage.style.width = "96%";
      stage.style.height = "auto";
    }
  }

  const clip = activeClip();
  if (!clip) return;
  const { w: srcW, h: srcH } = videoNativeDims(clip.video_id);

  // Stage's on-screen pixel size
  const stageW = stage.clientWidth;
  const stageH = stage.clientHeight;
  if (!stageW || !stageH) return;

  // pixels-per-canvas-unit on screen
  const pxPerCanvasX = stageW / state.canvas.w;
  const pxPerCanvasY = stageH / state.canvas.h;

  // Render dimensions in canvas units (matches backend math).
  const renderW_canvas = state.canvas.w * clip.scale;
  const renderH_canvas = renderW_canvas * (srcH / srcW);

  // Convert to on-screen pixels.
  const renderW_px = renderW_canvas * pxPerCanvasX;
  const renderH_px = renderH_canvas * pxPerCanvasY;
  const leftPx = state.canvas.w * clip.pos_x * pxPerCanvasX - renderW_px / 2;
  const topPx = state.canvas.h * clip.pos_y * pxPerCanvasY - renderH_px / 2;

  for (const v of [videoEls.A, videoEls.B]) {
    if (!v) continue;
    v.style.width = renderW_px + "px";
    v.style.height = renderH_px + "px";
    v.style.left = leftPx + "px";
    v.style.top = topPx + "px";
    v.style.objectFit = "fill";
  }

  // Sync UI for this clip.
  const scaleSlider = document.getElementById("clip-scale");
  const scaleDisplay = document.getElementById("clip-scale-display");
  if (scaleSlider && document.activeElement !== scaleSlider) {
    scaleSlider.value = clip.scale.toFixed(2);
  }
  if (scaleDisplay) {
    scaleDisplay.textContent = clip.scale.toFixed(2) + "×";
  }
}

function commitTransformChange() {
  refreshDirty();
  // Don't snapshot every drag pixel; caller should pushHistory once at drag start.
}

function setCanvasSize(w, h) {
  w = Math.max(16, Math.min(7680, Math.round(w)));
  h = Math.max(16, Math.min(7680, Math.round(h)));
  // Force even (libx264 requirement).
  w -= w % 2;
  h -= h % 2;
  if (w === state.canvas.w && h === state.canvas.h) return;
  pushHistory();
  state.canvas = { w, h };
  document.getElementById("canvas-w").value = w;
  document.getElementById("canvas-h").value = h;
  applyStage();
  refreshDirty();
}

function setupCanvasControls() {
  const wIn = document.getElementById("canvas-w");
  const hIn = document.getElementById("canvas-h");
  const slider = document.getElementById("clip-scale");
  const resetBtn = document.getElementById("clip-reset");
  const stage = document.getElementById("stage");

  if (!wIn || !hIn || !slider || !stage) return;

  wIn.value = state.canvas.w;
  hIn.value = state.canvas.h;

  const commitCanvas = () => {
    setCanvasSize(parseInt(wIn.value, 10) || state.canvas.w,
                  parseInt(hIn.value, 10) || state.canvas.h);
  };
  wIn.addEventListener("change", commitCanvas);
  hIn.addEventListener("change", commitCanvas);

  for (const btn of document.querySelectorAll(".canvas-controls .cc-presets button")) {
    btn.onclick = () => {
      const aspect = btn.dataset.aspect;
      const [a, b] = aspect.split(":").map(Number);
      // Keep current longer edge as 1080 (typical short-video output).
      const baseLong = Math.max(a, b) === a ? 1920 : 1920;  // always 1920 for the longer side
      // Simpler: set explicit dimensions matching common short-form sizes.
      let w, h;
      if (aspect === "9:16") { w = 1080; h = 1920; }
      else if (aspect === "16:9") { w = 1920; h = 1080; }
      else if (aspect === "1:1") { w = 1080; h = 1080; }
      else if (aspect === "4:5") { w = 1080; h = 1350; }
      setCanvasSize(w, h);
    };
  }

  // Scale slider — operates on active clip.
  let scaleHistoryPushed = false;
  slider.addEventListener("pointerdown", () => {
    if (activeClip()) pushHistory();
    scaleHistoryPushed = true;
  });
  slider.addEventListener("input", () => {
    const c = activeClip();
    if (!c) return;
    c.scale = parseFloat(slider.value);
    document.getElementById("clip-scale-display").textContent = c.scale.toFixed(2) + "×";
    applyStage();
    commitTransformChange();
  });
  slider.addEventListener("pointerup", () => { scaleHistoryPushed = false; });

  resetBtn.onclick = () => {
    const c = activeClip();
    if (!c) return;
    pushHistory();
    c.pos_x = 0.5; c.pos_y = 0.5; c.scale = 1.0;
    applyStage();
    refreshDirty();
  };

  // Drag handler on stage — moves active clip.
  let drag = null;
  stage.addEventListener("pointerdown", (e) => {
    const c = activeClip();
    if (!c) return;
    pushHistory();
    drag = {
      startX: e.clientX,
      startY: e.clientY,
      origPosX: c.pos_x,
      origPosY: c.pos_y,
      stageRect: stage.getBoundingClientRect(),
    };
    stage.classList.add("dragging");
    stage.setPointerCapture(e.pointerId);
  });
  stage.addEventListener("pointermove", (e) => {
    if (!drag) return;
    const c = activeClip();
    if (!c) { drag = null; return; }
    const dx = e.clientX - drag.startX;
    const dy = e.clientY - drag.startY;
    // Convert px delta to canvas-fraction delta.
    c.pos_x = Math.max(-1, Math.min(2, drag.origPosX + dx / drag.stageRect.width));
    c.pos_y = Math.max(-1, Math.min(2, drag.origPosY + dy / drag.stageRect.height));
    applyStage();
  });
  const endDrag = (e) => {
    if (!drag) return;
    drag = null;
    stage.classList.remove("dragging");
    try { stage.releasePointerCapture(e.pointerId); } catch (_) {}
    refreshDirty();
  };
  stage.addEventListener("pointerup", endDrag);
  stage.addEventListener("pointercancel", endDrag);

  // Re-apply stage when video metadata loads (so native dims are correct).
  for (const v of [videoEls.A, videoEls.B]) {
    if (!v) continue;
    v.addEventListener("loadedmetadata", () => applyStage());
  }

  window.addEventListener("resize", applyStage);
}

function setupEditor() {
  if (editorReady) return;
  editorReady = true;

  $("#play-btn").onclick = () => { togglePlay(); $("#play-btn").blur(); };
  $("#split-btn").onclick = () => { doSplit(); };
  $("#delete-btn").onclick = () => { doDelete(); };
  $("#auto-silence-btn").onclick = () => { $("#auto-silence-modal").hidden = false; };
  $("#auto-silence-cancel").onclick = () => { $("#auto-silence-modal").hidden = true; };
  $("#auto-silence-go").onclick = () => {
    const threshold = parseFloat($("#silence-threshold").value) || 0.02;
    const minDur = parseFloat($("#silence-min-dur").value) || 0.5;
    const pad = parseFloat($("#silence-pad").value) || 0.1;
    $("#auto-silence-modal").hidden = true;
    doAutoRemoveSilence(threshold, minDur, pad);
  };
  $("#export-btn").onclick = () => { doExport(); };
  $("#save-btn").onclick = () => { saveProject(); };
  $("#add-video-btn").onclick = () => { $("#add-video-input").click(); };
  $("#add-video-input").onchange = (e) => {
    if (e.target.files.length) addVideoToProject(e.target.files[0]);
    e.target.value = "";
  };
  $("#add-music-btn").onclick = () => { $("#add-music-input").click(); };
  $("#add-music-input").onchange = (e) => {
    if (e.target.files.length) addMusicToProject(e.target.files[0]);
    e.target.value = "";
  };

  // Bind events to BOTH video elements — the active one drives state.
  for (const v of [videoEls.A, videoEls.B]) {
    // timeupdate fires only every ~250ms, too coarse to transition exactly at
    // src_end. We use it as a backup; the rAF loop below polls at ~60Hz so
    // preview's clip boundary matches what export produces.
    v.addEventListener("timeupdate", (e) => { if (e.target === activeVideoEl()) onVideoTime(); });
    v.addEventListener("seeked", (e) => { if (e.target === activeVideoEl()) onVideoTime(); });
    v.addEventListener("play", (e) => {
      if (e.target !== activeVideoEl()) return;
      state.isPlaying = true;
      $("#play-btn").textContent = "⏸ Pause";
      ensureNextVideoBuffered();
      syncMusicToEdit(currentEditTime, true);
      startPlaybackPoll();
    });
    v.addEventListener("pause", (e) => {
      if (e.target !== activeVideoEl()) return;
      state.isPlaying = false;
      $("#play-btn").textContent = "▶ Play";
      stopAllMusic();
      stopPlaybackPoll();
    });
    v.addEventListener("ended", (e) => {
      if (e.target !== activeVideoEl()) return;
      state.isPlaying = false;
      stopAllMusic();
      stopPlaybackPoll();
    });
  }

  document.addEventListener("keydown", (e) => {
    if (state.projectId === null) return;
    const tag = e.target.tagName;
    if (tag === "INPUT" || tag === "TEXTAREA") return;
    const ctrl = e.ctrlKey || e.metaKey;
    // Use e.code (physical key, layout-independent) so shortcuts work on Thai/non-English keyboards.
    const code = e.code;

    if (ctrl && code === "KeyZ") {
      e.preventDefault();
      if (e.shiftKey) redo(); else undo();
    } else if (ctrl && code === "KeyY") {
      e.preventDefault(); redo();
    } else if (ctrl && code === "KeyC") {
      e.preventDefault(); doCopy();
    } else if (ctrl && code === "KeyV") {
      e.preventDefault(); doPaste();
    } else if (ctrl && code === "KeyS") {
      e.preventDefault(); saveProject();
    } else if (code === "Space") {
      e.preventDefault(); togglePlay();
    } else if (code === "KeyS") {
      e.preventDefault(); doSplit();
    } else if (e.key === "Delete" || e.key === "Backspace") {
      e.preventDefault(); doDelete();
    } else if (e.key === "ArrowLeft") {
      e.preventDefault(); nudge(e.shiftKey ? -1 : -0.1);
    } else if (e.key === "ArrowRight") {
      e.preventDefault(); nudge(e.shiftKey ? 1 : 0.1);
    }
  });

  $("#timeline").addEventListener("click", onTimelineClick);
  setupScrub();
  setupZoom();
  window.addEventListener("resize", () => requestAnimationFrame(redrawWaveforms));
  window.addEventListener("beforeunload", (e) => {
    if (state.dirty) {
      e.preventDefault();
      e.returnValue = "";
    }
  });
}

let scrubDown = null;
let scrubbing = false;
let scrubWasPlaying = false;
let blockNextClick = false;

function setupZoom() {
  $("#zoom-in").onclick = () => setZoom(state.zoom * 1.5);
  $("#zoom-out").onclick = () => setZoom(state.zoom / 1.5);
  $("#zoom-fit").onclick = () => setZoom(1.0);

  const scroll = $("#timeline-scroll");
  scroll.addEventListener("wheel", (e) => {
    if (e.ctrlKey || e.metaKey) {
      e.preventDefault();
      // Zoom centered on cursor's edit time
      const content = $("#timeline-content");
      const rect = content.getBoundingClientRect();
      const px = e.clientX - rect.left;
      const total = editDuration();
      const anchorTime = total > 0 ? Math.max(0, Math.min(total, (px / rect.width) * total)) : 0;
      const factor = e.deltaY < 0 ? 1.2 : 1 / 1.2;
      setZoom(state.zoom * factor, anchorTime);
    }
  }, { passive: false });

  applyZoom();
}

function ensurePlayheadVisible() {
  const scroll = $("#timeline-scroll");
  const content = $("#timeline-content");
  const total = editDuration();
  if (total <= 0) return;
  const phPx = (currentEditTime / total) * content.clientWidth;
  const view = scroll.clientWidth;
  const margin = view * 0.1;
  if (phPx < scroll.scrollLeft + margin) {
    scroll.scrollLeft = Math.max(0, phPx - margin);
  } else if (phPx > scroll.scrollLeft + view - margin) {
    scroll.scrollLeft = phPx - view + margin;
  }
}

function setupScrub() {
  const ruler = $("#timeline-ruler");

  ruler.addEventListener("pointerdown", (e) => {
    if (e.button !== 0) return;
    scrubDown = { x: e.clientX };
    scrubbing = false;
    // Click-to-seek on the ruler immediately (zoom-aware via content rect)
    const content = $("#timeline-content");
    const rect = content.getBoundingClientRect();
    const px = Math.max(0, Math.min(rect.width, e.clientX - rect.left));
    const t = (px / rect.width) * editDuration();
    seekToEdit(t);
    e.preventDefault();
  });

  window.addEventListener("pointermove", (e) => {
    if (!scrubDown) return;
    const dx = e.clientX - scrubDown.x;
    if (!scrubbing && Math.abs(dx) > 3) {
      scrubbing = true;
      if (isAudioOnly()) {
        scrubWasPlaying = state.isPlaying;
        if (state.isPlaying) audioOnlyPause();
      } else {
        const v = activeVideoEl();
        scrubWasPlaying = !v.paused;
        v.pause();
      }
      document.body.style.userSelect = "none";
      document.body.style.cursor = "ew-resize";
    }
    if (scrubbing) {
      const content = $("#timeline-content");
      const rect = content.getBoundingClientRect();
      const px = Math.max(0, Math.min(rect.width, e.clientX - rect.left));
      const t = (px / rect.width) * editDuration();
      seekToEdit(t);
      e.preventDefault();
    }
  });

  window.addEventListener("pointerup", () => {
    if (scrubbing) {
      if (scrubWasPlaying) {
        if (isAudioOnly()) audioOnlyPlay();
        else activeVideoEl().play();
      }
      blockNextClick = true;
      setTimeout(() => { blockNextClick = false; }, 50);
    }
    scrubDown = null;
    scrubbing = false;
    document.body.style.userSelect = "";
    document.body.style.cursor = "";
  });

  document.addEventListener(
    "click",
    (e) => {
      if (blockNextClick) {
        e.stopPropagation();
        e.preventDefault();
        blockNextClick = false;
      }
    },
    true,
  );
}

function nudge(seconds) {
  const total = editDuration();
  currentEditTime = Math.max(0, Math.min(total, currentEditTime + seconds));
  seekToEdit(currentEditTime);
}

function togglePlay() {
  if (isAudioOnly()) {
    if (state.isPlaying) {
      audioOnlyPause();
    } else {
      audioOnlyPlay();
    }
    return;
  }
  const v = activeVideoEl();
  if (v.paused) {
    if (currentEditTime >= editDuration() - 0.05) {
      currentEditTime = 0;
      seekToEdit(0);
    }
    v.play();
    ensureNextVideoBuffered();
    syncMusicToEdit(currentEditTime, true);
  } else {
    v.pause();
    stopAllMusic();
  }
}

// ---- Audio-only playback (no video element to drive currentTime) ----

let audioOnlyPollRafId = null;

function audioOnlyPlay() {
  if (currentEditTime >= editDuration() - 0.05) currentEditTime = 0;
  state.isPlaying = true;
  $("#play-btn").textContent = "⏸ Pause";
  syncMusicToEdit(currentEditTime, true);
  startAudioOnlyPoll();
}

function audioOnlyPause() {
  state.isPlaying = false;
  $("#play-btn").textContent = "▶ Play";
  stopAllMusic();
  stopAudioOnlyPoll();
}

function startAudioOnlyPoll() {
  if (audioOnlyPollRafId !== null) return;
  const tick = () => {
    if (!state.isPlaying) { audioOnlyPollRafId = null; return; }
    const ranges = musicEditRanges();
    const r = ranges.find((rg) => currentEditTime >= rg.edit_start && currentEditTime < rg.edit_end);
    if (r) {
      const el = audioEls[r.clip.audio_id];
      if (el && !el.paused) {
        currentEditTime = r.edit_start + Math.max(0, el.currentTime - r.clip.src_start);
      }
    }
    const total = editDuration();
    if (currentEditTime >= total - 0.02) {
      currentEditTime = total;
      audioOnlyPause();
      updateUI();
      return;
    }
    syncMusicToEdit(currentEditTime, true);
    updateUI();
    ensurePlayheadVisible();
    audioOnlyPollRafId = requestAnimationFrame(tick);
  };
  audioOnlyPollRafId = requestAnimationFrame(tick);
}

function stopAudioOnlyPoll() {
  if (audioOnlyPollRafId !== null) cancelAnimationFrame(audioOnlyPollRafId);
  audioOnlyPollRafId = null;
}

function seekToEdit(editTime) {
  const m = editToSrc(editTime);
  if (m) {
    state.activeClipIdx = state.clips.indexOf(m.clip);
    if (state.loadedVideoId !== m.clip.video_id) {
      ensureVideoLoaded(m.clip.video_id, m.srcTime);
    } else {
      try { activeVideoEl().currentTime = m.srcTime; } catch (_) {}
    }
    ensureNextVideoBuffered();
  }
  currentEditTime = editTime;
  syncMusicToEdit(editTime, state.isPlaying);
  updateUI();
}

// Polls activeVideoEl().currentTime at requestAnimationFrame rate (~60Hz)
// during playback. Without this, the only signal is HTMLMediaElement's
// `timeupdate` event which fires every ~250ms — too coarse to transition
// exactly at src_end, so preview would overshoot and the export's hard cut
// would seem to remove trailing audio that preview kept playing past the cut.
let playbackPollRafId = null;
function startPlaybackPoll() {
  if (playbackPollRafId !== null) return;
  const tick = () => {
    if (!state.isPlaying) {
      playbackPollRafId = null;
      return;
    }
    onVideoTime();
    playbackPollRafId = requestAnimationFrame(tick);
  };
  playbackPollRafId = requestAnimationFrame(tick);
}
function stopPlaybackPoll() {
  if (playbackPollRafId !== null) cancelAnimationFrame(playbackPollRafId);
  playbackPollRafId = null;
}

function onVideoTime() {
  const v = activeVideoEl();
  const t = v.currentTime;

  if (!state.isPlaying) {
    // Seeking / paused: sync edit time from source time within the current video.
    const clip = findClipBySrcTime(t, state.loadedVideoId);
    if (clip) {
      currentEditTime = clipOffset(clip) + (t - clip.src_start);
      state.activeClipIdx = state.clips.indexOf(clip);
    }
    updateUI();
    return;
  }

  // Playback: drive position from activeClipIdx so we don't lose the next clip
  // when timeupdate fires slightly past src_end (a previous bug caused jumps to end).
  let active = state.clips[state.activeClipIdx];
  if (!active || state.loadedVideoId !== active.video_id) {
    // Out of sync (e.g. just after a swap/load). Recover from edit time.
    const m = editToSrc(currentEditTime);
    if (!m) return;
    state.activeClipIdx = state.clips.indexOf(m.clip);
    active = m.clip;
    if (!active) return;
  }

  if (t >= active.src_end) {
    advanceToNextClip();
    return;
  }

  if (t >= active.src_start - 0.03) {
    currentEditTime = clipOffset(active) + Math.max(0, t - active.src_start);
  }
  syncMusicToEdit(currentEditTime, true);
  updateUI();
  ensurePlayheadVisible();
}

function advanceToNextClip() {
  const nextIdx = state.activeClipIdx + 1;
  const next = state.clips[nextIdx];
  if (!next) {
    activeVideoEl().pause();
    currentEditTime = editDuration();
    state.activeClipIdx = Math.max(0, state.clips.length - 1);
    updateUI();
    return;
  }
  state.activeClipIdx = nextIdx;
  const wasPlaying = state.isPlaying;

  if (state.loadedVideoId === next.video_id) {
    // Same video — direct seek (fast)
    try { activeVideoEl().currentTime = next.src_start; } catch (_) {}
    currentEditTime = clipOffset(next);
    updateUI();
    ensurePlayheadVisible();
    ensureNextVideoBuffered();
    return;
  }

  if (bufferLoadedFor && bufferLoadedFor.video_id === next.video_id) {
    // Buffer is ready — atomic swap (no perceptible stutter)
    swapToBufferAt(next.src_start);
    currentEditTime = clipOffset(next);
    updateUI();
    ensurePlayheadVisible();
    ensureNextVideoBuffered();
    return;
  }

  // Cold load fallback (first boundary if user didn't pause long enough for buffer)
  activeVideoEl().pause();
  ensureVideoLoaded(next.video_id, next.src_start).then(() => {
    currentEditTime = clipOffset(next);
    updateUI();
    ensurePlayheadVisible();
    if (wasPlaying) activeVideoEl().play();
    ensureNextVideoBuffered();
  });
}

function onTimelineClick(e) {
  if (e.target.closest(".clip-block")) return;
  if (e.target.closest("#timeline-ruler")) return; // ruler handles its own scrub/seek
  const rect = $("#timeline-content").getBoundingClientRect();
  const x = e.clientX - rect.left;
  if (x < 0 || x > rect.width) return;
  const t = (x / rect.width) * editDuration();
  state.selectedClipId = null;
  seekToEdit(t);
  renderTimeline();
}

function doSplitMusic() {
  if (!state.selectedMusicId) return false;
  const range = musicEditRanges().find((r) => r.clip.id === state.selectedMusicId);
  if (!range) return false;
  const t = currentEditTime;
  if (t <= range.edit_start + 0.1 || t >= range.edit_end - 0.1) return false;
  const splitSrc = range.clip.src_start + (t - range.edit_start);

  pushHistory();
  const idx = state.musicClips.indexOf(range.clip);
  const a = {
    id: state.nextMusicId++, audio_id: range.clip.audio_id,
    src_start: range.clip.src_start, src_end: splitSrc, volume: range.clip.volume,
  };
  const b = {
    id: state.nextMusicId++, audio_id: range.clip.audio_id,
    src_start: splitSrc, src_end: range.clip.src_end, volume: range.clip.volume,
  };
  state.musicClips.splice(idx, 1, a, b);
  state.selectedMusicId = b.id;
  refreshDirty();
  renderTimeline();
  return true;
}

function doSplit() {
  // If a music clip is selected, split music. Otherwise split video.
  if (state.selectedMusicId && doSplitMusic()) return;

  const t = currentEditTime;
  const total = editDuration();
  if (t <= 0.1 || t >= total - 0.1) return;

  const m = editToSrc(t);
  if (!m) return;
  const clip = m.clip;
  const splitAt = m.srcTime;
  if (splitAt <= clip.src_start + 0.1 || splitAt >= clip.src_end - 0.1) return;

  pushHistory();
  const idx = state.clips.indexOf(clip);
  const a = { id: state.nextClipId++, video_id: clip.video_id, src_start: clip.src_start, src_end: splitAt,
              pos_x: clip.pos_x, pos_y: clip.pos_y, scale: clip.scale };
  const b = { id: state.nextClipId++, video_id: clip.video_id, src_start: splitAt, src_end: clip.src_end,
              pos_x: clip.pos_x, pos_y: clip.pos_y, scale: clip.scale };
  state.clips.splice(idx, 1, a, b);
  state.selectedClipId = b.id;
  refreshActiveClip();
  refreshDirty();
  renderTimeline();
}

function findSilentRanges(clip, threshold, minDurSec, padSec) {
  const peaks = state.peaksByVideo[clip.video_id];
  const source = getVideo(clip.video_id);
  if (!peaks || peaks.length === 0 || !source || !source.has_audio || source.duration === 0) return [];

  const peakDurSec = source.duration / peaks.length;
  const minPeaks = Math.max(1, Math.floor(minDurSec / peakDurSec));
  const padPeaks = Math.floor(padSec / peakDurSec);
  const startIdx = Math.max(0, Math.floor((clip.src_start / source.duration) * peaks.length));
  const endIdx = Math.min(peaks.length, Math.ceil((clip.src_end / source.duration) * peaks.length));

  const runs = [];
  let runStart = -1;
  const flush = (runEnd) => {
    if (runStart === -1) return;
    if (runEnd - runStart >= minPeaks) {
      const sStart = (runStart + padPeaks) * peakDurSec;
      const sEnd = (runEnd - padPeaks) * peakDurSec;
      if (sEnd > sStart) runs.push([sStart, sEnd]);
    }
    runStart = -1;
  };
  for (let i = startIdx; i < endIdx; i++) {
    const p = peaks[i];
    const amp = Math.max(Math.abs(p[0]), Math.abs(p[1]));
    if (amp < threshold) {
      if (runStart === -1) runStart = i;
    } else {
      flush(i);
    }
  }
  flush(endIdx);

  return runs
    .map(([s, e]) => [Math.max(clip.src_start, s), Math.min(clip.src_end, e)])
    .filter(([s, e]) => e - s > 0.05);
}

function doAutoRemoveSilence(threshold, minDurSec, padSec) {
  if (state.clips.length === 0) return;
  const newClips = [];
  let cutsCount = 0;
  let removedSec = 0;

  for (const clip of state.clips) {
    const silences = findSilentRanges(clip, threshold, minDurSec, padSec);
    if (silences.length === 0) {
      newClips.push(clip);
      continue;
    }
    let cursor = clip.src_start;
    for (const [sStart, sEnd] of silences) {
      if (sStart > cursor + 0.05) {
        newClips.push({
          id: state.nextClipId++, video_id: clip.video_id,
          src_start: cursor, src_end: sStart,
          pos_x: clip.pos_x, pos_y: clip.pos_y, scale: clip.scale,
        });
      }
      removedSec += sEnd - Math.max(sStart, cursor);
      cursor = sEnd;
      cutsCount++;
    }
    if (cursor < clip.src_end - 0.05) {
      newClips.push({
        id: state.nextClipId++, video_id: clip.video_id,
        src_start: cursor, src_end: clip.src_end,
        pos_x: clip.pos_x, pos_y: clip.pos_y, scale: clip.scale,
      });
    }
  }

  if (cutsCount === 0) {
    alert("ไม่พบช่วงเงียบตามเกณฑ์ — ลองเพิ่มค่า threshold หรือลด min duration");
    return;
  }
  if (newClips.length === 0) {
    alert("ตัด silence แล้วจะไม่เหลืออะไรเลย — ลองลด threshold");
    return;
  }

  pushHistory();
  state.clips = newClips;
  state.selectedClipId = null;
  const total = editDuration();
  if (currentEditTime > total) currentEditTime = Math.max(0, total - 0.1);
  seekToEdit(currentEditTime);
  refreshActiveClip();
  refreshDirty();
  renderTimeline();
  alert(`ตัดช่วงเงียบ ${cutsCount} จุด — ลบออกไป ${removedSec.toFixed(1)} วินาที (Ctrl+Z = ย้อน)`);
}

function doDelete() {
  // Delete selected music clip, if any. Otherwise delete selected video clip.
  if (state.selectedMusicId) {
    const idx = state.musicClips.findIndex((m) => m.id === state.selectedMusicId);
    if (idx === -1) return;
    pushHistory();
    state.musicClips.splice(idx, 1);
    state.selectedMusicId = null;
    stopAllMusic();
    refreshDirty();
    renderTimeline();
    return;
  }
  if (!state.selectedClipId || state.clips.length <= 1) return;
  const idx = state.clips.findIndex((c) => c.id === state.selectedClipId);
  if (idx === -1) return;
  pushHistory();
  state.clips.splice(idx, 1);
  state.selectedClipId = null;

  const total = editDuration();
  if (currentEditTime > total) currentEditTime = Math.max(0, total - 0.1);
  seekToEdit(currentEditTime);
  refreshDirty();
  renderTimeline();
}

function doCopy() {
  if (!state.selectedClipId) return;
  const clip = state.clips.find((c) => c.id === state.selectedClipId);
  if (!clip) return;
  state.clipboard = { video_id: clip.video_id, src_start: clip.src_start, src_end: clip.src_end,
                      pos_x: clip.pos_x, pos_y: clip.pos_y, scale: clip.scale };
}

function doPaste() {
  if (!state.clipboard) return;
  pushHistory();
  let insertIdx;
  if (state.selectedClipId) {
    insertIdx = state.clips.findIndex((c) => c.id === state.selectedClipId) + 1;
  } else {
    insertIdx = state.clips.length;
  }
  const newClip = {
    id: state.nextClipId++,
    video_id: state.clipboard.video_id,
    src_start: state.clipboard.src_start,
    src_end: state.clipboard.src_end,
    pos_x: state.clipboard.pos_x ?? 0.5,
    pos_y: state.clipboard.pos_y ?? 0.5,
    scale: state.clipboard.scale ?? 1.0,
  };
  state.clips.splice(insertIdx, 0, newClip);
  state.selectedClipId = newClip.id;
  refreshActiveClip();
  refreshDirty();
  renderTimeline();
}

// ---------- Render ----------

function renderVideosPanel() {
  const panel = $("#videos-panel");
  panel.innerHTML = "";
  for (const v of state.videos) {
    const chip = document.createElement("div");
    chip.className = "video-chip";
    chip.style.setProperty("--chip-color", videoColor(v.video_id));

    const dot = document.createElement("span");
    dot.className = "dot";
    chip.appendChild(dot);

    const name = document.createElement("span");
    name.className = "chip-name";
    name.textContent = v.filename;
    name.title = v.filename;
    chip.appendChild(name);

    const meta = document.createElement("span");
    meta.className = "chip-meta";
    meta.textContent = fmt(v.duration);
    chip.appendChild(meta);

    const x = document.createElement("button");
    x.className = "chip-remove";
    x.textContent = "×";
    x.title = "ลบวิดีโอออกจากโปรเจกต์";
    x.onclick = (e) => {
      e.stopPropagation();
      removeVideo(v);
    };
    chip.appendChild(x);
    panel.appendChild(chip);
  }
}

async function removeVideo(video) {
  const used = state.clips.some((c) => c.video_id === video.video_id);
  const willRemoveCount = state.clips.filter((c) => c.video_id === video.video_id).length;
  let msg = `ลบวิดีโอ "${video.filename}" ออกจากโปรเจกต์?`;
  if (used) msg += `\nClip ที่ใช้วิดีโอนี้จะถูกลบไปด้วย (${willRemoveCount} clip)`;
  if (!confirm(msg)) return;

  // Don't allow removing the last video if it'd leave the project empty —
  // user can delete the whole project from home if that's the intent.
  if (state.videos.length <= 1) {
    alert("ลบไม่ได้ — ต้องมีวิดีโออย่างน้อย 1 ไฟล์ในโปรเจกต์ (ถ้าจะทิ้งทั้งโปรเจกต์ ลบจากหน้าแรก)");
    return;
  }

  try {
    const res = await fetch(`/api/projects/${state.projectId}/videos/${video.video_id}`, { method: "DELETE" });
    if (!res.ok) throw new Error(await res.text());
  } catch (e) {
    alert("ลบผิดพลาด: " + e.message);
    return;
  }

  pushHistory();
  state.videos = state.videos.filter((v) => v.video_id !== video.video_id);
  delete state.peaksByVideo[video.video_id];
  delete state.peaksScale[video.video_id];
  state.clips = state.clips.filter((c) => c.video_id !== video.video_id);

  // If currently loaded video was removed, swap to first remaining clip's video
  if (state.loadedVideoId === video.video_id) {
    state.loadedVideoId = null;
    if (state.clips.length > 0) {
      ensureVideoLoaded(state.clips[0].video_id, state.clips[0].src_start);
    } else {
      activeVideoEl().src = "";
    }
  }
  // Invalidate buffer if it held the removed video
  if (bufferLoadedFor && bufferLoadedFor.video_id === video.video_id) {
    bufferVideoEl().src = "";
    bufferLoadedFor = null;
  }
  currentEditTime = Math.min(currentEditTime, editDuration());
  refreshActiveClip();
  // Server already persisted the change — treat as saved baseline
  state.savedHash = clipsHash(state.clips);
  setDirty(false);
  renderTimeline();
}

function renderTimeline() {
  const total = editDuration();
  const clipsEl = $("#clips");
  clipsEl.innerHTML = "";
  if (total <= 0) { updateUI(); return; }

  for (const clip of state.clips) {
    const dur = clip.src_end - clip.src_start;
    const block = document.createElement("div");
    block.className = "clip-block";
    if (clip.id === state.selectedClipId) block.classList.add("selected");
    block.style.flexBasis = ((dur / total) * 100) + "%";
    block.style.setProperty("--clip-color", videoColor(clip.video_id));
    block.dataset.clipId = clip.id;
    block.draggable = true;

    const canvas = document.createElement("canvas");
    block.appendChild(canvas);

    const label = document.createElement("div");
    label.className = "clip-label";
    label.textContent = `${fmt(clip.src_start)}–${fmt(clip.src_end)}`;
    block.appendChild(label);

    block.addEventListener("click", (e) => {
      e.stopPropagation();
      state.selectedClipId = clip.id;
      const offset = clipOffset(clip);
      seekToEdit(offset);
      renderTimeline();
    });

    setupClipDrag(block, clip);
    clipsEl.appendChild(block);
  }

  renderMusicTrack();
  requestAnimationFrame(redrawWaveforms);
  renderVideosPanel();
  updateUI();
}

function renderMusicTrack() {
  const total = editDuration();
  const musicEl = $("#music-clips");
  if (!musicEl) return;
  musicEl.innerHTML = "";
  if (total <= 0 || state.musicClips.length === 0) return;

  const musicTotal = state.musicClips.reduce((s, m) => s + (m.src_end - m.src_start), 0);
  const overflow = musicTotal > total + 0.05;
  if (overflow) {
    const warn = document.createElement("div");
    warn.className = "music-overflow-warn";
    warn.textContent = `⚠ เพลงยาวเกินวีดีโอ ${(musicTotal - total).toFixed(1)}s — ลากขอบขวาเพื่อตัด`;
    musicEl.appendChild(warn);
  }

  for (const mc of state.musicClips) {
    const dur = Math.max(0, mc.src_end - mc.src_start);
    if (dur <= 0) continue;
    const block = document.createElement("div");
    block.className = "music-block";
    if (mc.id === state.selectedMusicId) block.classList.add("selected");
    block.style.flexBasis = ((dur / total) * 100) + "%";
    block.dataset.musicId = mc.id;

    const canvas = document.createElement("canvas");
    block.appendChild(canvas);

    const audio = state.audios.find((a) => a.audio_id === mc.audio_id);
    const label = document.createElement("div");
    label.className = "music-label";
    label.textContent = audio?.filename || "เพลง";
    block.appendChild(label);

    // Draggable horizontal volume line — top of block = 100%, bottom = 0%.
    const volLine = document.createElement("div");
    volLine.className = "volume-line";
    volLine.style.top = ((1 - mc.volume) * 100) + "%";
    volLine.title = "ลากขึ้น/ลงเพื่อปรับความดัง";
    const volTag = document.createElement("div");
    volTag.className = "volume-tag";
    volTag.textContent = `${Math.round(mc.volume * 100)}%`;
    volTag.style.top = ((1 - mc.volume) * 100) + "%";
    volLine.addEventListener("mousedown", (e) => {
      e.stopPropagation();
      e.preventDefault();
      const rect = block.getBoundingClientRect();
      block.classList.add("adjusting-volume");
      const onMove = (ev) => {
        const y = Math.max(0, Math.min(rect.height, ev.clientY - rect.top));
        const v = Math.max(0, Math.min(1, 1 - y / rect.height));
        mc.volume = v;
        const pct = (v * 100);
        volLine.style.top = ((1 - v) * 100) + "%";
        volTag.style.top = ((1 - v) * 100) + "%";
        volTag.textContent = `${Math.round(pct)}%`;
        const el = audioEls[mc.audio_id];
        if (el) el.volume = v;
      };
      const onUp = () => {
        document.removeEventListener("mousemove", onMove);
        document.removeEventListener("mouseup", onUp);
        block.classList.remove("adjusting-volume");
        pushHistory();
        refreshDirty();
      };
      document.addEventListener("mousemove", onMove);
      document.addEventListener("mouseup", onUp);
    });
    block.appendChild(volLine);
    block.appendChild(volTag);

    const del = document.createElement("button");
    del.className = "music-delete";
    del.textContent = "✕";
    del.title = "ลบ clip นี้ออกจาก timeline";
    del.addEventListener("click", (e) => {
      e.stopPropagation();
      pushHistory();
      state.musicClips = state.musicClips.filter((m) => m.id !== mc.id);
      if (state.selectedMusicId === mc.id) state.selectedMusicId = null;
      stopAllMusic();
      refreshDirty();
      renderTimeline();
    });
    block.appendChild(del);

    const trim = document.createElement("div");
    trim.className = "music-trim";
    trim.title = "ลากเพื่อตัดความยาวเพลง";
    trim.addEventListener("mousedown", (e) => {
      e.stopPropagation();
      e.preventDefault();
      const audioMeta = state.audios.find((a) => a.audio_id === mc.audio_id);
      const audioDur = audioMeta?.duration || mc.src_end;
      const startX = e.clientX;
      const startEnd = mc.src_end;
      const pxPerSec = block.getBoundingClientRect().width / (mc.src_end - mc.src_start);
      block.classList.add("trimming");
      const onMove = (ev) => {
        const dSec = (ev.clientX - startX) / pxPerSec;
        const next = Math.max(mc.src_start + 0.1, Math.min(audioDur, startEnd + dSec));
        mc.src_end = next;
        renderTimeline();
      };
      const onUp = () => {
        document.removeEventListener("mousemove", onMove);
        document.removeEventListener("mouseup", onUp);
        block.classList.remove("trimming");
        pushHistory();
        refreshDirty();
      };
      document.addEventListener("mousemove", onMove);
      document.addEventListener("mouseup", onUp);
    });
    block.appendChild(trim);

    block.addEventListener("click", (e) => {
      e.stopPropagation();
      state.selectedMusicId = mc.id;
      state.selectedClipId = null;
      renderTimeline();
    });

    musicEl.appendChild(block);
  }
}

function redrawWaveforms() {
  for (const block of document.querySelectorAll(".clip-block")) {
    const id = parseInt(block.dataset.clipId);
    const clip = state.clips.find((c) => c.id === id);
    if (clip) drawClipWaveform(block.querySelector("canvas"), clip);
  }
  for (const block of document.querySelectorAll(".music-block")) {
    const id = parseInt(block.dataset.musicId);
    const mc = state.musicClips.find((c) => c.id === id);
    if (mc) drawMusicWaveform(block.querySelector("canvas"), mc);
  }
}

function drawMusicWaveform(canvas, mc) {
  const w = canvas.parentElement.clientWidth;
  const h = canvas.parentElement.clientHeight;
  if (w === 0 || h === 0) return;
  const dpr = window.devicePixelRatio || 1;
  canvas.width = Math.max(1, Math.floor(w * dpr));
  canvas.height = Math.max(1, Math.floor(h * dpr));
  canvas.style.width = w + "px";
  canvas.style.height = h + "px";

  const ctx = canvas.getContext("2d");
  ctx.scale(dpr, dpr);
  ctx.clearRect(0, 0, w, h);

  const peaks = state.peaksByAudio[mc.audio_id];
  const audio = state.audios.find((a) => a.audio_id === mc.audio_id);
  if (!peaks || !audio || audio.duration === 0) return;

  const startIdx = Math.floor((mc.src_start / audio.duration) * peaks.length);
  const endIdx = Math.ceil((mc.src_end / audio.duration) * peaks.length);
  const slice = peaks.slice(startIdx, endIdx);
  if (slice.length === 0) return;

  ctx.fillStyle = "#4ade80";
  const mid = h / 2;
  const drawW = Math.max(1, w);
  const scale = state.peaksScaleByAudio[mc.audio_id] || 1;
  for (let x = 0; x < drawW; x++) {
    const i0 = Math.floor((x / drawW) * slice.length);
    const i1 = Math.max(i0 + 1, Math.floor(((x + 1) / drawW) * slice.length));
    let pmin = 0, pmax = 0;
    for (let i = i0; i < i1 && i < slice.length; i++) {
      if (slice[i][0] < pmin) pmin = slice[i][0];
      if (slice[i][1] > pmax) pmax = slice[i][1];
    }
    const minY = mid + pmin * mid * scale;
    const maxY = mid + pmax * mid * scale;
    ctx.fillRect(x, minY, 1, Math.max(1, maxY - minY));
  }
}

function drawClipWaveform(canvas, clip) {
  const w = canvas.parentElement.clientWidth;
  const h = canvas.parentElement.clientHeight;
  if (w === 0 || h === 0) return;
  const dpr = window.devicePixelRatio || 1;
  canvas.width = Math.max(1, Math.floor(w * dpr));
  canvas.height = Math.max(1, Math.floor(h * dpr));
  canvas.style.width = w + "px";
  canvas.style.height = h + "px";

  const ctx = canvas.getContext("2d");
  ctx.scale(dpr, dpr);
  ctx.clearRect(0, 0, w, h);

  const peaks = state.peaksByVideo[clip.video_id];
  const source = getVideo(clip.video_id);
  if (!peaks || !source || source.duration === 0) return;

  const startIdx = Math.floor((clip.src_start / source.duration) * peaks.length);
  const endIdx = Math.ceil((clip.src_end / source.duration) * peaks.length);
  const slice = peaks.slice(startIdx, endIdx);
  if (slice.length === 0) return;

  ctx.fillStyle = "#7dd3fc";
  const mid = h / 2;
  const drawW = Math.max(1, w);
  const scale = state.peaksScale[clip.video_id] || 1;
  // Aggregate min/max over every peak that falls into this pixel's range.
  // Subsampling (one peak per pixel) made silence "shift" when canvas width
  // changed after a split — same peaks land on different pixels, gaps move.
  for (let x = 0; x < drawW; x++) {
    const i0 = Math.floor((x / drawW) * slice.length);
    const i1 = Math.max(i0 + 1, Math.floor(((x + 1) / drawW) * slice.length));
    let pmin = 0, pmax = 0;
    for (let i = i0; i < i1 && i < slice.length; i++) {
      if (slice[i][0] < pmin) pmin = slice[i][0];
      if (slice[i][1] > pmax) pmax = slice[i][1];
    }
    const minY = mid + pmin * mid * scale;
    const maxY = mid + pmax * mid * scale;
    ctx.fillRect(x, minY, 1, Math.max(1, maxY - minY));
  }
}

function updateUI() {
  const total = editDuration();
  $("#time-display").textContent = `${fmt(currentEditTime)} / ${fmt(total)}`;
  const ph = $("#playhead");
  ph.style.left = total > 0 ? ((currentEditTime / total) * 100) + "%" : "0%";
  $("#delete-btn").disabled = !state.selectedClipId || state.clips.length <= 1;
  $("#split-btn").disabled = total <= 0.2;
  $("#export-btn").disabled = state.clips.length === 0;
}

function setupClipDrag(block, clip) {
  block.addEventListener("dragstart", (e) => {
    e.dataTransfer.setData("text/plain", String(clip.id));
    e.dataTransfer.effectAllowed = "move";
    block.classList.add("dragging");
  });
  block.addEventListener("dragend", () => {
    block.classList.remove("dragging");
    document.querySelectorAll(".clip-block").forEach((b) =>
      b.classList.remove("drop-before", "drop-after")
    );
  });
  block.addEventListener("dragover", (e) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    const rect = block.getBoundingClientRect();
    const isLeft = e.clientX < rect.left + rect.width / 2;
    block.classList.toggle("drop-before", isLeft);
    block.classList.toggle("drop-after", !isLeft);
  });
  block.addEventListener("dragleave", () => {
    block.classList.remove("drop-before", "drop-after");
  });
  block.addEventListener("drop", (e) => {
    e.preventDefault();
    block.classList.remove("drop-before", "drop-after");
    const draggedId = parseInt(e.dataTransfer.getData("text/plain"));
    if (draggedId === clip.id) return;

    const draggedIdx = state.clips.findIndex((c) => c.id === draggedId);
    if (draggedIdx === -1) return;

    const rect = block.getBoundingClientRect();
    const isLeft = e.clientX < rect.left + rect.width / 2;

    pushHistory();
    const [dragged] = state.clips.splice(draggedIdx, 1);
    let targetIdx = state.clips.findIndex((c) => c.id === clip.id);
    if (!isLeft) targetIdx += 1;
    state.clips.splice(targetIdx, 0, dragged);

    refreshActiveClip();
    refreshDirty();
    renderTimeline();
  });
}

// ---------- Add video to existing project ----------

async function addVideoToProject(file) {
  if (!state.projectId) return;

  const modal = $("#export-modal");
  const fill = $("#export-fill");
  const label = $("#export-label");
  $("#export-modal h3").textContent = "อัปโหลดวิดีโอเพิ่ม";
  modal.hidden = false;
  fill.style.width = "0%";
  label.textContent = "กำลังอัปโหลด...";

  const fd = new FormData();
  fd.append("file", file);

  try {
    const xhr = new XMLHttpRequest();
    const result = await new Promise((res, rej) => {
      xhr.upload.onprogress = (e) => {
        if (!e.lengthComputable) return;
        const pct = (e.loaded / e.total) * 100;
        fill.style.width = pct + "%";
        label.textContent = `อัปโหลด ${pct.toFixed(0)}% (${fmtSize(e.loaded)} / ${fmtSize(e.total)})`;
      };
      xhr.upload.onloadend = () => {
        fill.style.width = "100%";
        label.textContent = "กำลังประมวลผล... สร้าง waveform";
      };
      xhr.onload = () => {
        if (xhr.status === 200) res(JSON.parse(xhr.responseText));
        else rej(new Error(xhr.responseText || xhr.statusText));
      };
      xhr.onerror = () => rej(new Error("network"));
      xhr.open("POST", `/api/projects/${state.projectId}/videos`);
      xhr.send(fd);
    });

    pushHistory();
    state.videos.push({
      video_id: result.video_id,
      filename: result.filename,
      duration: result.duration,
      width: result.width,
      height: result.height,
      has_audio: result.has_audio,
    });
    const peaksRes = await fetch(`/api/peaks/${result.video_id}`);
    const peaks = await peaksRes.json();
    state.peaksByVideo[result.video_id] = peaks;
    state.peaksScale[result.video_id] = computePeaksScale(peaks);

    state.clips.push({
      id: state.nextClipId++,
      video_id: result.video_id,
      src_start: 0,
      src_end: result.duration,
      pos_x: 0.5,
      pos_y: 0.5,
      scale: 1.0,
    });
    refreshDirty();
    renderTimeline();
    modal.hidden = true;
    $("#export-modal h3").textContent = "กำลัง Export";
  } catch (e) {
    alert("เพิ่มวิดีโอผิดพลาด: " + e.message);
    modal.hidden = true;
    $("#export-modal h3").textContent = "กำลัง Export";
  }
}

async function addMusicToProject(file) {
  if (!state.projectId) return;

  const modal = $("#export-modal");
  const fill = $("#export-fill");
  const label = $("#export-label");
  $("#export-modal h3").textContent = "อัปโหลดเพลง";
  modal.hidden = false;
  fill.style.width = "0%";
  label.textContent = "กำลังอัปโหลด...";

  const fd = new FormData();
  fd.append("file", file);

  try {
    const xhr = new XMLHttpRequest();
    const result = await new Promise((res, rej) => {
      xhr.upload.onprogress = (e) => {
        if (!e.lengthComputable) return;
        const pct = (e.loaded / e.total) * 100;
        fill.style.width = pct + "%";
        label.textContent = `อัปโหลด ${pct.toFixed(0)}% (${fmtSize(e.loaded)} / ${fmtSize(e.total)})`;
      };
      xhr.upload.onloadend = () => {
        fill.style.width = "100%";
        label.textContent = "กำลังประมวลผล... สร้าง waveform";
      };
      xhr.onload = () => {
        if (xhr.status === 200) res(JSON.parse(xhr.responseText));
        else rej(new Error(xhr.responseText || xhr.statusText));
      };
      xhr.onerror = () => rej(new Error("network"));
      xhr.open("POST", `/api/projects/${state.projectId}/audios`);
      xhr.send(fd);
    });

    pushHistory();
    state.audios.push({
      audio_id: result.audio_id,
      filename: result.filename,
      ext: result.ext,
      duration: result.duration,
    });
    const peaksRes = await fetch(`/api/peaks/${result.audio_id}`);
    const peaks = await peaksRes.json();
    state.peaksByAudio[result.audio_id] = peaks;
    state.peaksScaleByAudio[result.audio_id] = computePeaksScale(peaks);

    // Cap new music clip so total music ≤ video duration (auto-trim to fit).
    const videoDur = editDuration();
    const musicUsed = state.musicClips.reduce((s, m) => s + (m.src_end - m.src_start), 0);
    const remaining = Math.max(0.1, videoDur - musicUsed);
    state.musicClips.push({
      id: state.nextMusicId++,
      audio_id: result.audio_id,
      src_start: 0,
      src_end: Math.min(result.duration, remaining),
      volume: 0.3,
    });
    refreshDirty();
    renderTimeline();
    modal.hidden = true;
    $("#export-modal h3").textContent = "กำลัง Export";
  } catch (e) {
    alert("เพิ่มเพลงผิดพลาด: " + e.message);
    modal.hidden = true;
    $("#export-modal h3").textContent = "กำลัง Export";
  }
}

// ---------- Save ----------

async function saveProject() {
  if (!state.projectId) return;
  const btn = $("#save-btn");
  btn.disabled = true;
  btn.textContent = "กำลังบันทึก...";
  try {
    const res = await fetch(`/api/projects/${state.projectId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        canvas: { w: state.canvas.w, h: state.canvas.h },
        clips: state.clips.map((c) => ({
          video_id: c.video_id,
          src_start: c.src_start,
          src_end: c.src_end,
          pos_x: c.pos_x,
          pos_y: c.pos_y,
          scale: c.scale,
        })),
        music_clips: state.musicClips.map((m) => ({
          audio_id: m.audio_id,
          src_start: m.src_start,
          src_end: m.src_end,
          volume: m.volume,
        })),
      }),
    });
    if (!res.ok) throw new Error(await res.text());
    state.savedHash = clipsHash(state.clips);
    setDirty(false);
  } catch (e) {
    alert("บันทึกผิดพลาด: " + e.message);
    btn.disabled = false;
    btn.textContent = "💾 Save";
  }
}

// ---------- Export ----------

function doExport() {
  const baseName = (state.projectName || state.filename || "video").replace(/\.[^.]+$/, "");
  $("#export-filename").value = `${baseName}-edit.mp4`;
  $("#export-options-modal").hidden = false;
}

async function startExport(filename) {
  const segments = state.clips.map((c) => ({
    video_id: c.video_id,
    start: c.src_start,
    end: c.src_end,
    pos_x: c.pos_x,
    pos_y: c.pos_y,
    scale: c.scale,
  }));
  const music = state.musicClips.map((m) => ({
    audio_id: m.audio_id,
    start: m.src_start,
    end: m.src_end,
    volume: m.volume,
  }));
  const canvas = { w: state.canvas.w, h: state.canvas.h };

  const modal = $("#export-modal");
  const fill = $("#export-fill");
  const label = $("#export-label");
  modal.hidden = false;
  fill.style.width = "0%";
  label.textContent = "ส่งคำขอ...";

  try {
    const res = await fetch("/api/export", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ segments, music, canvas, filename }),
    });
    if (!res.ok) throw new Error(await res.text());
    const { job_id } = await res.json();

    while (true) {
      await new Promise((r) => setTimeout(r, 800));
      const sr = await fetch(`/api/export/${job_id}`);
      const status = await sr.json();
      const pct = (status.progress || 0) * 100;
      fill.style.width = pct + "%";
      const verb = status.status === "running" ? "re-encode" : status.status;
      label.textContent = `${verb} ${pct.toFixed(0)}%`;
      if (status.status === "done") {
        const url = `/api/download/${job_id}`;
        // Trigger download via anchor click (more reliable than location.href,
        // which some browsers block when triggered from an async callback).
        const a = document.createElement("a");
        a.href = url;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        a.remove();
        // Also show a manual download link in case the auto-click was blocked.
        label.innerHTML = `เสร็จแล้ว — <a href="${url}" download="${filename}" style="color: var(--primary); text-decoration: underline">คลิกเพื่อดาวน์โหลด</a>`;
        // Add a close button so user can dismiss when ready
        if (!modal.querySelector(".modal-actions")) {
          const actions = document.createElement("div");
          actions.className = "modal-actions";
          actions.style.marginTop = "16px";
          const close = document.createElement("button");
          close.textContent = "ปิด";
          close.onclick = () => { modal.hidden = true; actions.remove(); };
          actions.appendChild(close);
          modal.querySelector(".modal-card").appendChild(actions);
        }
        break;
      } else if (status.status === "error") {
        alert("Export error: " + (status.error || "unknown"));
        modal.hidden = true;
        break;
      }
    }
  } catch (e) {
    alert("Export error: " + e.message);
    modal.hidden = true;
  }
}

function setupExportModal() {
  $("#export-cancel").onclick = () => { $("#export-options-modal").hidden = true; };
  $("#export-go").onclick = () => {
    let filename = $("#export-filename").value.trim();
    if (!filename) filename = "export.mp4";
    if (!/\.mp4$/i.test(filename)) filename += ".mp4";
    $("#export-options-modal").hidden = true;
    startExport(filename);
  };
}

// ---------- Init ----------

$("#new-project-btn").onclick = () => showScreen("upload");
$("#back-btn").onclick = goHome;
$("#home-link").onclick = goHome;

setupUpload();
setupExportModal();
showScreen("home");
loadProjects();
