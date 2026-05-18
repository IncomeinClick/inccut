"""inccut — simple cut/join video editor."""
import asyncio
import base64
import json
import os
import secrets
import subprocess
import threading
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional

import bcrypt
import numpy as np
from fastapi import BackgroundTasks, FastAPI, File, Form, HTTPException, Request, UploadFile
from fastapi.responses import FileResponse, HTMLResponse, JSONResponse, RedirectResponse, Response
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel
from starlette.middleware.sessions import SessionMiddleware

BASE = Path("/opt/inccut")
UPLOADS = BASE / "uploads"
PREVIEWS = BASE / "previews"
EXPORTS = BASE / "exports"
PROJECTS_FILE = BASE / "projects.json"
HTPASSWD_FILE = Path("/etc/nginx/.htpasswd-inccut")
for d in (UPLOADS, PREVIEWS, EXPORTS):
    d.mkdir(exist_ok=True)

SESSION_SECRET = os.environ.get("INCCUT_SECRET", "change-me")
SESSION_MAX_AGE = 60 * 60 * 24 * 90  # 90 days


def load_htpasswd() -> dict[str, bytes]:
    """Parse /etc/nginx/.htpasswd-inccut → {username: bcrypt_hash_bytes}."""
    creds: dict[str, bytes] = {}
    if not HTPASSWD_FILE.exists():
        return creds
    for line in HTPASSWD_FILE.read_text().splitlines():
        if ":" not in line or not line.strip():
            continue
        user, _, h = line.partition(":")
        # Apache uses $2y$ but bcrypt expects $2b$ or $2a$ — normalize
        if h.startswith("$2y$"):
            h = "$2b$" + h[4:]
        creds[user.strip()] = h.encode()
    return creds


AUTH_CREDS = load_htpasswd()


def check_password(username: str, password: str) -> bool:
    stored = AUTH_CREDS.get(username)
    if not stored:
        return False
    try:
        return bcrypt.checkpw(password.encode(), stored)
    except Exception:
        return False


def check_basic_header(auth_header: str) -> bool:
    if not auth_header or not auth_header.startswith("Basic "):
        return False
    try:
        decoded = base64.b64decode(auth_header[6:]).decode("utf-8", "ignore")
        u, _, p = decoded.partition(":")
        return check_password(u, p)
    except Exception:
        return False


app = FastAPI(title="inccut")

jobs: dict[str, dict] = {}
_projects_lock = threading.Lock()


# --- Auth -------------------------------------------------------------------

LOGIN_HTML = """<!doctype html>
<html lang=\"en\"><head>
<meta charset=\"utf-8\">
<meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">
<title>inccut — login</title>
<style>
body{margin:0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;background:#0f1217;color:#eee;}
.wrap{max-width:380px;margin:80px auto;padding:32px;background:#1a1d24;border-radius:12px;border:1px solid #2a2f3a;}
.wrap h1{margin:0 0 6px;font-size:28px;}
.wrap h1 span{color:#22c55e;}
.wrap .sub{color:#888;font-size:13px;margin-bottom:24px;}
.wrap label{display:block;font-size:12px;color:#aaa;margin:14px 0 6px;}
.wrap input{width:100%;padding:10px 12px;background:#0f1217;border:1px solid #2a2f3a;border-radius:6px;color:#eee;font-size:14px;box-sizing:border-box;}
.wrap input:focus{outline:none;border-color:#22c55e;}
.wrap button{margin-top:20px;width:100%;padding:11px;background:#22c55e;color:#000;border:none;border-radius:6px;font-size:14px;font-weight:600;cursor:pointer;}
.wrap button:hover{background:#16a34a;}
.wrap .err{margin-top:14px;padding:10px;background:#3a1a1a;border:1px solid #6b2424;border-radius:6px;color:#f87171;font-size:13px;}
</style>
</head><body>
<div class=\"wrap\">
  <h1>inc<span>cut</span></h1>
  <div class=\"sub\">Sign in to continue</div>
  __ERR__
  <form method=\"post\" action=\"/login\">
    <label>Email</label>
    <input type=\"text\" name=\"username\" autocomplete=\"username\" required autofocus>
    <label>Password</label>
    <input type=\"password\" name=\"password\" autocomplete=\"current-password\" required>
    <button type=\"submit\">Sign in</button>
  </form>
</div>
</body></html>"""


def render_login(error: str = "") -> str:
    err_html = f'<div class="err">{error}</div>' if error else ""
    return LOGIN_HTML.replace("__ERR__", err_html)


@app.middleware("http")
async def auth_middleware(request: Request, call_next):
    path = request.url.path
    if path in ("/login", "/healthz"):
        return await call_next(request)

    has_session = bool(request.session.get("user"))

    # API routes: accept session OR basic auth (so scripts/curl still work)
    if path.startswith("/api/"):
        if has_session or check_basic_header(request.headers.get("Authorization", "")):
            return await call_next(request)
        return JSONResponse(
            {"detail": "Unauthorized"},
            status_code=401,
            headers={"WWW-Authenticate": 'Basic realm="inccut"'},
        )

    # Everything else (UI, static assets): require session
    if has_session:
        return await call_next(request)
    return RedirectResponse("/login", status_code=303)


app.add_middleware(
    SessionMiddleware,
    secret_key=SESSION_SECRET,
    max_age=SESSION_MAX_AGE,
    same_site="lax",
    https_only=True,
)


@app.get("/login")
def login_page(request: Request):
    if request.session.get("user"):
        return RedirectResponse("/", status_code=303)
    return HTMLResponse(render_login())


@app.post("/login")
async def login_submit(request: Request, username: str = Form(...), password: str = Form(...)):
    if check_password(username, password):
        request.session["user"] = username
        return RedirectResponse("/", status_code=303)
    return HTMLResponse(render_login("Invalid email or password"), status_code=401)


@app.post("/logout")
def logout(request: Request):
    request.session.clear()
    return RedirectResponse("/login", status_code=303)


@app.get("/healthz")
def healthz():
    return {"ok": True}


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def load_projects() -> dict:
    if not PROJECTS_FILE.exists():
        return {}
    try:
        return json.loads(PROJECTS_FILE.read_text())
    except json.JSONDecodeError:
        return {}


def save_projects(d: dict) -> None:
    tmp = PROJECTS_FILE.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(d, indent=2, ensure_ascii=False))
    tmp.replace(PROJECTS_FILE)


def ffprobe_duration(path: Path) -> float:
    proc = subprocess.run(
        ["ffprobe", "-v", "error", "-show_entries", "format=duration",
         "-of", "default=nw=1:nk=1", str(path)],
        capture_output=True, text=True,
    )
    try:
        return float(proc.stdout.strip())
    except ValueError:
        return 0.0


def ffprobe_dimensions(path: Path) -> tuple[int, int]:
    """Returns (width, height) of the first video stream, or (0, 0) on failure."""
    proc = subprocess.run(
        ["ffprobe", "-v", "error", "-select_streams", "v:0",
         "-show_entries", "stream=width,height",
         "-of", "csv=p=0:s=x", str(path)],
        capture_output=True, text=True,
    )
    try:
        w_s, h_s = proc.stdout.strip().split("x")
        return int(w_s), int(h_s)
    except (ValueError, IndexError):
        return 0, 0


def generate_peaks(video_path: Path) -> list:
    """Extract audio waveform peaks via ffmpeg → mono 8 kHz s16le PCM.
    Peak count scales with duration (~20 peaks/sec, capped) so long videos
    keep enough resolution to spot short silences.
    """
    proc = subprocess.run(
        ["ffmpeg", "-i", str(video_path), "-vn", "-ac", "1", "-ar", "8000",
         "-f", "s16le", "-loglevel", "error", "-"],
        capture_output=True,
    )
    if not proc.stdout:
        return []
    samples = np.frombuffer(proc.stdout, dtype=np.int16).astype(np.float32) / 32768.0
    if samples.size == 0:
        return []
    duration_sec = samples.size / 8000.0
    num_peaks = int(min(120_000, max(1_000, duration_sec * 20)))
    chunk_count = min(num_peaks, samples.size)
    chunks = np.array_split(samples, chunk_count)
    return [[float(c.min()), float(c.max())] for c in chunks if c.size > 0]


AUDIO_EXTS = {".mp3", ".m4a", ".aac", ".wav", ".ogg", ".flac", ".opus"}


async def process_audio_upload(file: UploadFile) -> dict:
    """Save audio file as-is + generate peaks. Returns audio metadata."""
    ext = Path(file.filename).suffix.lower() or ".mp3"
    if ext not in AUDIO_EXTS:
        raise HTTPException(400, f"Unsupported audio format: {ext}")
    audio_id = uuid.uuid4().hex[:12]
    dst = PREVIEWS / f"{audio_id}{ext}"

    with open(dst, "wb") as f:
        while chunk := await file.read(4 * 1024 * 1024):
            f.write(chunk)

    duration = ffprobe_duration(dst)
    if duration <= 0:
        dst.unlink(missing_ok=True)
        raise HTTPException(400, "Could not read audio duration — invalid file?")
    peaks = await asyncio.to_thread(generate_peaks, dst)
    (PREVIEWS / f"{audio_id}.peaks.json").write_text(json.dumps(peaks))

    return {
        "audio_id": audio_id,
        "filename": file.filename,
        "ext": ext,
        "duration": duration,
    }


def audio_path(audio_id: str, ext: str) -> Path:
    return PREVIEWS / f"{audio_id}{ext}"


def make_thumbnail(video_path: Path, dst: Path, at: float = 1.0) -> None:
    subprocess.run(
        ["ffmpeg", "-y", "-ss", f"{at}", "-i", str(video_path),
         "-vframes", "1", "-vf", "scale=480:-2",
         "-loglevel", "error", str(dst)],
        capture_output=True, text=True,
    )


def make_preview(src: Path, dst: Path) -> None:
    """Re-mux source to mp4 with stream-copy. Falls back to audio re-encode, then full re-encode."""
    attempts = [
        # 1. Pure stream-copy (fastest, works for H.264+AAC sources regardless of container)
        ["-c", "copy", "-movflags", "+faststart"],
        # 2. Copy video, re-encode audio (handles MKV with Vorbis/Opus)
        ["-c:v", "copy", "-c:a", "aac", "-b:a", "192k", "-movflags", "+faststart"],
        # 3. Full re-encode (last resort, e.g. VP9 source)
        ["-c:v", "libx264", "-preset", "fast", "-crf", "18",
         "-c:a", "aac", "-b:a", "192k", "-movflags", "+faststart"],
    ]
    last_err = ""
    for args in attempts:
        proc = subprocess.run(
            ["ffmpeg", "-y", "-i", str(src), *args, "-loglevel", "error", str(dst)],
            capture_output=True, text=True,
        )
        if proc.returncode == 0 and dst.exists() and dst.stat().st_size > 0:
            return
        last_err = proc.stderr[-400:]
    raise RuntimeError(f"ffmpeg failed: {last_err}")


async def process_upload(file: UploadFile) -> dict:
    """Save + re-mux + peaks + thumbnail. Returns video metadata."""
    video_id = uuid.uuid4().hex[:12]
    src_ext = Path(file.filename).suffix.lower() or ".bin"
    src_path = UPLOADS / f"{video_id}{src_ext}"

    with open(src_path, "wb") as f:
        while chunk := await file.read(4 * 1024 * 1024):
            f.write(chunk)

    preview_path = PREVIEWS / f"{video_id}.mp4"
    try:
        await asyncio.to_thread(make_preview, src_path, preview_path)
    except Exception as e:
        src_path.unlink(missing_ok=True)
        raise HTTPException(500, f"Failed to process video: {e}")

    duration = ffprobe_duration(preview_path)
    width, height = ffprobe_dimensions(preview_path)
    peaks = await asyncio.to_thread(generate_peaks, preview_path)
    (PREVIEWS / f"{video_id}.peaks.json").write_text(json.dumps(peaks))

    thumb_path = PREVIEWS / f"{video_id}.thumb.jpg"
    await asyncio.to_thread(make_thumbnail, preview_path, thumb_path, min(1.0, duration / 2))

    src_path.unlink(missing_ok=True)
    return {
        "video_id": video_id,
        "filename": file.filename,
        "duration": duration,
        "width": width,
        "height": height,
        "has_audio": bool(peaks),
    }


def normalize_project(p: dict) -> dict:
    """Migrate older schemas. Idempotent."""
    if "videos" not in p:
        vid = p.get("video_id")
        if vid is None:
            p["videos"] = []
            p["clips"] = []
        else:
            p["videos"] = [{
                "video_id": vid,
                "filename": p.get("filename", ""),
                "duration": p.get("duration", 0),
                "has_audio": True,
            }]
            p["clips"] = [{**c, "video_id": vid} for c in p.get("clips", [])]
            p.pop("video_id", None)
            p.pop("duration", None)
            p.pop("filename", None)
    # Music layer is opt-in — older projects may not have it.
    p.setdefault("audios", [])
    p.setdefault("music_clips", [])

    # Backfill video dimensions for older uploads (probe the preview mp4).
    for v in p.get("videos", []):
        if not v.get("width") or not v.get("height"):
            preview = PREVIEWS / f"{v['video_id']}.mp4"
            if preview.exists():
                w, h = ffprobe_dimensions(preview)
                if w and h:
                    v["width"], v["height"] = w, h

    # Canvas default: first video's dimensions, falling back to 1080x1920.
    if not p.get("canvas"):
        first = next((v for v in p.get("videos", []) if v.get("width") and v.get("height")), None)
        if first:
            p["canvas"] = {"w": first["width"], "h": first["height"]}
        else:
            p["canvas"] = {"w": 1080, "h": 1920}

    # Per-clip transform defaults: centered, cover-fit (scale=1.0).
    for c in p.get("clips", []):
        c.setdefault("pos_x", 0.5)
        c.setdefault("pos_y", 0.5)
        c.setdefault("scale", 1.0)
    return p


@app.post("/api/upload")
async def upload(file: UploadFile = File(...)):
    if not file.filename:
        raise HTTPException(400, "No filename")

    ext = Path(file.filename).suffix.lower()
    project_id = uuid.uuid4().hex[:12]
    project_name = Path(file.filename).stem or "Untitled"

    if ext in AUDIO_EXTS:
        # Audio-first project: start empty, add the audio onto the music track.
        info = await process_audio_upload(file)
        with _projects_lock:
            projects = load_projects()
            projects[project_id] = {
                "name": project_name,
                "videos": [],
                "clips": [],
                "audios": [info],
                "music_clips": [{
                    "audio_id": info["audio_id"],
                    "src_start": 0.0,
                    "src_end": info["duration"],
                    "volume": 0.3,
                }],
                "created_at": now_iso(),
                "updated_at": now_iso(),
            }
            save_projects(projects)
        return {
            "project_id": project_id,
            "name": project_name,
            **info,
            "clips": [],
        }

    info = await process_upload(file)
    with _projects_lock:
        projects = load_projects()
        projects[project_id] = {
            "name": project_name,
            "videos": [info],
            "clips": [{"video_id": info["video_id"], "src_start": 0.0, "src_end": info["duration"]}],
            "created_at": now_iso(),
            "updated_at": now_iso(),
        }
        save_projects(projects)

    return {
        "project_id": project_id,
        "name": project_name,
        **info,
        "clips": projects[project_id]["clips"],
    }


@app.delete("/api/projects/{pid}/videos/{video_id}")
async def remove_video(pid: str, video_id: str):
    with _projects_lock:
        p = load_projects()
        if pid not in p:
            raise HTTPException(404)
        proj = normalize_project(p[pid])
        if not any(v["video_id"] == video_id for v in proj["videos"]):
            raise HTTPException(404, "video not in project")
        proj["videos"] = [v for v in proj["videos"] if v["video_id"] != video_id]
        proj["clips"] = [c for c in proj["clips"] if c["video_id"] != video_id]
        proj["updated_at"] = now_iso()
        p[pid] = proj
        save_projects(p)

    # Free media files if no project still references this video
    referenced = any(
        v["video_id"] == video_id
        for o in p.values()
        for v in normalize_project(o).get("videos", [])
    )
    if not referenced:
        for ext in (".mp4", ".peaks.json", ".thumb.jpg"):
            (PREVIEWS / f"{video_id}{ext}").unlink(missing_ok=True)

    return {"ok": True, "videos": proj["videos"], "clips": proj["clips"]}


@app.post("/api/projects/{pid}/audios")
async def add_audio(pid: str, file: UploadFile = File(...)):
    if not file.filename:
        raise HTTPException(400, "No filename")
    info = await process_audio_upload(file)
    with _projects_lock:
        projects = load_projects()
        if pid not in projects:
            raise HTTPException(404)
        proj = normalize_project(projects[pid])
        proj["audios"].append(info)
        proj["music_clips"].append({
            "audio_id": info["audio_id"],
            "src_start": 0.0,
            "src_end": info["duration"],
            "volume": 0.3,
        })
        proj["updated_at"] = now_iso()
        projects[pid] = proj
        save_projects(projects)
    return {**info, "music_clips": proj["music_clips"]}


@app.delete("/api/projects/{pid}/audios/{audio_id}")
async def remove_audio(pid: str, audio_id: str):
    with _projects_lock:
        p = load_projects()
        if pid not in p:
            raise HTTPException(404)
        proj = normalize_project(p[pid])
        target = next((a for a in proj["audios"] if a["audio_id"] == audio_id), None)
        if not target:
            raise HTTPException(404, "audio not in project")
        proj["audios"] = [a for a in proj["audios"] if a["audio_id"] != audio_id]
        proj["music_clips"] = [c for c in proj["music_clips"] if c["audio_id"] != audio_id]
        proj["updated_at"] = now_iso()
        p[pid] = proj
        save_projects(p)

    referenced = any(
        a["audio_id"] == audio_id
        for o in p.values()
        for a in normalize_project(o).get("audios", [])
    )
    if not referenced:
        (PREVIEWS / f"{audio_id}.peaks.json").unlink(missing_ok=True)
        for ext in AUDIO_EXTS:
            (PREVIEWS / f"{audio_id}{ext}").unlink(missing_ok=True)

    return {"ok": True, "audios": proj["audios"], "music_clips": proj["music_clips"]}


@app.get("/api/audio/{audio_id}")
async def get_audio(audio_id: str, request: Request):
    """Serve audio file (any extension). Looks up by audio_id prefix."""
    for ext in AUDIO_EXTS:
        p = PREVIEWS / f"{audio_id}{ext}"
        if p.exists():
            return FileResponse(p)
    raise HTTPException(404)


@app.post("/api/projects/{pid}/videos")
async def add_video(pid: str, file: UploadFile = File(...)):
    if not file.filename:
        raise HTTPException(400, "No filename")
    info = await process_upload(file)

    with _projects_lock:
        projects = load_projects()
        if pid not in projects:
            raise HTTPException(404)
        proj = normalize_project(projects[pid])
        proj["videos"].append(info)
        proj["clips"].append({
            "video_id": info["video_id"],
            "src_start": 0.0,
            "src_end": info["duration"],
        })
        proj["updated_at"] = now_iso()
        projects[pid] = proj
        save_projects(projects)

    return {**info, "clips": proj["clips"]}


@app.get("/api/peaks/{video_id}")
async def get_peaks(video_id: str):
    p = PREVIEWS / f"{video_id}.peaks.json"
    if not p.exists():
        raise HTTPException(404)
    return JSONResponse(json.loads(p.read_text()))


@app.get("/api/preview/{video_id}.mp4")
async def get_preview(video_id: str, request: Request):
    """Serve preview mp4 with HTTP byte-range support so <video> seeking works."""
    p = PREVIEWS / f"{video_id}.mp4"
    if not p.exists():
        raise HTTPException(404)
    file_size = p.stat().st_size
    range_header = request.headers.get("range")
    if not range_header:
        return FileResponse(p, media_type="video/mp4")

    try:
        units, rng = range_header.split("=", 1)
        if units.strip() != "bytes":
            raise ValueError
        start_s, _, end_s = rng.partition("-")
        start = int(start_s) if start_s else 0
        end = int(end_s) if end_s else file_size - 1
        end = min(end, file_size - 1)
        if start > end or start < 0:
            raise ValueError
    except ValueError:
        return Response(status_code=416, headers={"Content-Range": f"bytes */{file_size}"})

    length = end - start + 1

    def iter_file():
        with open(p, "rb") as f:
            f.seek(start)
            remaining = length
            while remaining > 0:
                chunk = f.read(min(64 * 1024, remaining))
                if not chunk:
                    break
                remaining -= len(chunk)
                yield chunk

    return Response(
        content=b"".join(iter_file()),
        status_code=206,
        media_type="video/mp4",
        headers={
            "Content-Range": f"bytes {start}-{end}/{file_size}",
            "Accept-Ranges": "bytes",
            "Content-Length": str(length),
        },
    )


# ---- Projects ----

class ClipModel(BaseModel):
    video_id: str
    src_start: float
    src_end: float
    pos_x: float = 0.5
    pos_y: float = 0.5
    scale: float = 1.0


class MusicClipModel(BaseModel):
    audio_id: str
    src_start: float
    src_end: float
    volume: float = 0.3


class CanvasModel(BaseModel):
    w: int
    h: int


class ProjectUpdate(BaseModel):
    name: Optional[str] = None
    clips: Optional[list[ClipModel]] = None
    music_clips: Optional[list[MusicClipModel]] = None
    canvas: Optional[CanvasModel] = None


def project_total_duration(proj: dict) -> float:
    return sum(max(0, c["src_end"] - c["src_start"]) for c in proj.get("clips", []))


@app.get("/api/projects")
async def list_projects():
    p = load_projects()
    rows = []
    for pid, proj in p.items():
        proj = normalize_project(proj)
        videos = proj.get("videos", [])
        first_video_id = videos[0]["video_id"] if videos else None
        rows.append({
            "id": pid,
            "name": proj["name"],
            "video_id": first_video_id,  # for thumbnail
            "video_count": len(videos),
            "duration": project_total_duration(proj),
            "updated_at": proj.get("updated_at"),
        })
    rows.sort(key=lambda r: r.get("updated_at") or "", reverse=True)
    return rows


@app.get("/api/projects/{pid}")
async def get_project(pid: str):
    p = load_projects()
    if pid not in p:
        raise HTTPException(404)
    return {"id": pid, **normalize_project(p[pid])}


@app.patch("/api/projects/{pid}")
async def update_project(pid: str, req: ProjectUpdate):
    with _projects_lock:
        p = load_projects()
        if pid not in p:
            raise HTTPException(404)
        proj = normalize_project(p[pid])
        if req.name is not None:
            proj["name"] = req.name.strip() or proj["name"]
        if req.clips is not None:
            valid_vids = {v["video_id"] for v in proj["videos"]}
            for c in req.clips:
                if c.video_id not in valid_vids:
                    raise HTTPException(400, f"Unknown video_id: {c.video_id}")
            proj["clips"] = [c.model_dump() for c in req.clips]
        if req.music_clips is not None:
            valid_aids = {a["audio_id"] for a in proj.get("audios", [])}
            for c in req.music_clips:
                if c.audio_id not in valid_aids:
                    raise HTTPException(400, f"Unknown audio_id: {c.audio_id}")
            proj["music_clips"] = [c.model_dump() for c in req.music_clips]
        if req.canvas is not None:
            w = max(16, min(7680, req.canvas.w))
            h = max(16, min(7680, req.canvas.h))
            # Keep dims even — required by libx264 with yuv420p.
            proj["canvas"] = {"w": w - (w % 2), "h": h - (h % 2)}
        proj["updated_at"] = now_iso()
        p[pid] = proj
        save_projects(p)
    return {"ok": True}


@app.delete("/api/projects/{pid}")
async def delete_project(pid: str):
    with _projects_lock:
        p = load_projects()
        if pid not in p:
            raise HTTPException(404)
        proj = normalize_project(p.pop(pid))
        save_projects(p)
    # Delete each video's media files if no other project references it.
    other_vids: set[str] = set()
    for other in p.values():
        for v in normalize_project(other).get("videos", []):
            other_vids.add(v["video_id"])
    for v in proj.get("videos", []):
        if v["video_id"] in other_vids:
            continue
        for ext in (".mp4", ".peaks.json", ".thumb.jpg"):
            (PREVIEWS / f"{v['video_id']}{ext}").unlink(missing_ok=True)
    # Clean up unreferenced audio assets too
    other_aids: set[str] = set()
    for other in p.values():
        for a in normalize_project(other).get("audios", []):
            other_aids.add(a["audio_id"])
    for a in proj.get("audios", []):
        if a["audio_id"] in other_aids:
            continue
        (PREVIEWS / f"{a['audio_id']}.peaks.json").unlink(missing_ok=True)
        for ext in AUDIO_EXTS:
            (PREVIEWS / f"{a['audio_id']}{ext}").unlink(missing_ok=True)
    return {"ok": True}


@app.get("/api/thumbnail/{video_id}.jpg")
async def get_thumbnail(video_id: str):
    p = PREVIEWS / f"{video_id}.thumb.jpg"
    if not p.exists():
        raise HTTPException(404)
    return FileResponse(p, media_type="image/jpeg")


# ---- Export ----

class Segment(BaseModel):
    video_id: str
    start: float
    end: float
    pos_x: float = 0.5
    pos_y: float = 0.5
    scale: float = 1.0


class MusicSegment(BaseModel):
    audio_id: str
    start: float
    end: float
    volume: float = 0.3


class ExportRequest(BaseModel):
    segments: list[Segment]
    music: list[MusicSegment] = []
    canvas: CanvasModel
    filename: Optional[str] = None


def _even(x: float) -> int:
    n = int(round(x))
    return n - (n % 2)


def render_segment(src: Path, dst: Path, seg: dict, canvas_w: int, canvas_h: int) -> tuple[bool, str]:
    """Render one segment scaled+positioned onto a canvas-sized frame with
    normalized AAC 48k/stereo audio. Output is always canvas_w × canvas_h."""
    start = float(seg["start"])
    duration = float(seg["end"]) - start
    if duration <= 0:
        return False, "duration <= 0"

    src_w, src_h = ffprobe_dimensions(src)
    if not src_w or not src_h:
        return False, "could not probe source dimensions"

    pos_x = float(seg.get("pos_x", 0.5))
    pos_y = float(seg.get("pos_y", 0.5))
    scale = max(0.05, float(seg.get("scale", 1.0)))

    # scale=1.0 means video width fills canvas width. Height preserves source aspect.
    render_w = _even(canvas_w * scale)
    render_h = _even(render_w * (src_h / src_w))
    overlay_x = int(round(canvas_w * pos_x - render_w / 2))
    overlay_y = int(round(canvas_h * pos_y - render_h / 2))

    # HTML5 <video> displays the frame whose PTS is the latest ≤ currentTime
    # (the "before-start" frame). ffmpeg's -ss / trim instead start from the
    # first frame with PTS ≥ start. To make the export match the in-app
    # preview, seek ~1 frame BEFORE the requested start so that "before-start"
    # frame is included as the visual first frame. Audio is then advanced by
    # the same offset inside the filter graph so audio still plays from the
    # intended src_start.
    seek_offset = 1.0 / 30.0
    adj_start = max(0.0, start - seek_offset)
    seek_back = start - adj_start  # usually = seek_offset
    src_take = duration + seek_back + 0.5

    filter_complex = (
        # Video: include frame at PTS just before src_start (preview's first frame)
        f"[0:v]trim=duration={duration:.6f},setpts=PTS-STARTPTS,"
        f"fps=30,scale={render_w}:{render_h}[v];"
        f"color=black:s={canvas_w}x{canvas_h}:r=30:d={duration:.6f}[bg];"
        f"[bg][v]overlay={overlay_x}:{overlay_y}:eof_action=endall,format=yuv420p[vout];"
        # Audio: skip the seek-back amount so audio starts at the intended src_start
        f"[0:a]atrim=start={seek_back:.6f}:end={(seek_back + duration):.6f},"
        f"asetpts=PTS-STARTPTS,"
        f"apad=whole_dur={duration:.6f},"
        f"aformat=sample_rates=48000:channel_layouts=stereo[aout]"
    )
    # Audio: FLAC (lossless) inside MKV. AAC frame-boundary quantization in
    # per-segment files would accumulate sub-frame drift over hundreds of
    # clips; FLAC is sample-precise so concat is exact and AAC is encoded
    # only once at the end.
    cmd = [
        "ffmpeg", "-y", "-ss", f"{adj_start:.6f}", "-i", str(src),
        "-t", f"{src_take:.6f}",
        "-filter_complex", filter_complex,
        "-map", "[vout]", "-map", "[aout]",
        "-t", f"{duration:.6f}",
        "-c:v", "libx264", "-preset", "veryfast", "-crf", "18",
        "-pix_fmt", "yuv420p", "-r", "30", "-vsync", "cfr",
        "-c:a", "flac", "-ar", "48000", "-ac", "2",
        "-f", "matroska",
        "-loglevel", "error", str(dst),
    ]
    proc = subprocess.run(cmd, capture_output=True, text=True)
    return (proc.returncode == 0 and dst.exists() and dst.stat().st_size > 0,
            proc.stderr[-400:] if proc.stderr else "")


def find_audio_path(audio_id: str) -> Optional[Path]:
    for ext in AUDIO_EXTS:
        p = PREVIEWS / f"{audio_id}{ext}"
        if p.exists():
            return p
    return None


def build_music_track(music: list[dict], tmpdir: Path, total_dur: float) -> Optional[Path]:
    """Cut each music clip with volume applied, concat into one track, pad/trim
    to total_dur. Returns path to music wav, or None if no music."""
    if not music:
        return None
    seg_files = []
    for i, mc in enumerate(music):
        src = find_audio_path(mc["audio_id"])
        if src is None:
            raise RuntimeError(f"music clip {i}: audio {mc['audio_id']} not found")
        dur = mc["end"] - mc["start"]
        if dur <= 0:
            continue
        seg = tmpdir / f"mus-{i:04d}.wav"
        vol = max(0.0, float(mc.get("volume", 0.3)))
        proc = subprocess.run(
            ["ffmpeg", "-y", "-ss", f"{mc['start']:.3f}", "-i", str(src),
             "-t", f"{dur:.3f}", "-af", f"volume={vol:.3f}",
             "-ac", "2", "-ar", "44100",
             "-loglevel", "error", str(seg)],
            capture_output=True, text=True,
        )
        if proc.returncode != 0 or not seg.exists():
            raise RuntimeError(f"music clip {i} failed: {proc.stderr[-300:]}")
        seg_files.append(seg)
    if not seg_files:
        return None

    concat_list = tmpdir / "music_concat.txt"
    concat_list.write_text("\n".join(f"file '{f.resolve()}'" for f in seg_files))
    full = tmpdir / "music_full.wav"
    proc = subprocess.run(
        ["ffmpeg", "-y", "-f", "concat", "-safe", "0", "-i", str(concat_list),
         "-c", "copy", "-loglevel", "error", str(full)],
        capture_output=True, text=True,
    )
    if proc.returncode != 0:
        raise RuntimeError(f"music concat failed: {proc.stderr[-300:]}")

    # Pad with silence so amix duration=first works cleanly, then trim to total_dur.
    sized = tmpdir / "music_sized.wav"
    proc = subprocess.run(
        ["ffmpeg", "-y", "-i", str(full),
         "-af", f"apad,atrim=duration={total_dur:.3f}",
         "-loglevel", "error", str(sized)],
        capture_output=True, text=True,
    )
    if proc.returncode != 0:
        raise RuntimeError(f"music pad/trim failed: {proc.stderr[-300:]}")
    return sized


def run_export(job_id: str, out: Path, segments: list[dict], music: list[dict],
               canvas_w: int, canvas_h: int) -> None:
    jobs[job_id]["status"] = "running"
    tmpdir = out.parent / f"tmp-{job_id}"
    tmpdir.mkdir(exist_ok=True)
    try:
        seg_files: list[Path] = []
        total_dur = 0.0
        for i, seg in enumerate(segments):
            seg_file = tmpdir / f"seg-{i:04d}.mkv"
            duration = seg["end"] - seg["start"]
            if duration <= 0:
                continue
            src = PREVIEWS / f"{seg['video_id']}.mp4"
            if not src.exists():
                raise RuntimeError(f"segment {i}: source video {seg['video_id']} not found")
            ok, err = render_segment(src, seg_file, seg, canvas_w, canvas_h)
            if not ok:
                raise RuntimeError(f"segment {i} failed: {err}")
            seg_files.append(seg_file)
            total_dur += round(duration * 30) / 30
            jobs[job_id]["progress"] = (i + 1) / (len(segments) + 2)

        if not seg_files:
            raise RuntimeError("No segments to export")

        concat_list = tmpdir / "concat.txt"
        concat_list.write_text("\n".join(f"file '{f.resolve()}'" for f in seg_files))

        video_concat = tmpdir / "video_concat.mp4" if music else out

        # Concat per-segment files into final MP4 with single AAC encode.
        # Segments use lossless FLAC audio so concat is sample-precise; the
        # only AAC quantization happens here, once, at the final encode.
        proc = subprocess.run(
            ["ffmpeg", "-y", "-f", "concat", "-safe", "0", "-i", str(concat_list),
             "-c:v", "copy",
             "-c:a", "aac", "-b:a", "192k", "-ar", "48000", "-ac", "2",
             "-movflags", "+faststart",
             "-loglevel", "error", str(video_concat)],
            capture_output=True, text=True,
        )
        if proc.returncode != 0:
            raise RuntimeError(f"concat failed: {proc.stderr[-300:]}")

        if music:
            jobs[job_id]["progress"] = (len(segments) + 1) / (len(segments) + 2)
            music_track = build_music_track(music, tmpdir, total_dur)
            if music_track is None:
                # No usable music — just rename concat to out
                video_concat.rename(out)
            else:
                proc = subprocess.run(
                    ["ffmpeg", "-y", "-i", str(video_concat), "-i", str(music_track),
                     "-filter_complex",
                     # normalize=0 → don't divide outputs by N. Without this, video
                     # audio would be halved just because music is added as a second input.
                     "[0:a][1:a]amix=inputs=2:duration=first:dropout_transition=0:normalize=0[aout]",
                     "-map", "0:v", "-map", "[aout]",
                     "-c:v", "copy", "-c:a", "aac", "-b:a", "192k",
                     "-movflags", "+faststart",
                     "-loglevel", "error", str(out)],
                    capture_output=True, text=True,
                )
                if proc.returncode != 0:
                    raise RuntimeError(f"audio mix failed: {proc.stderr[-300:]}")

        jobs[job_id]["status"] = "done"
        jobs[job_id]["progress"] = 1.0
    except Exception as e:
        jobs[job_id]["status"] = "error"
        jobs[job_id]["error"] = str(e)
    finally:
        for f in tmpdir.glob("*"):
            try:
                f.unlink()
            except OSError:
                pass
        try:
            tmpdir.rmdir()
        except OSError:
            pass


@app.post("/api/export")
async def export(req: ExportRequest, bg: BackgroundTasks):
    if not req.segments:
        raise HTTPException(400, "No segments")
    for s in req.segments:
        if not (PREVIEWS / f"{s.video_id}.mp4").exists():
            raise HTTPException(404, f"Video {s.video_id} not found")

    job_id = uuid.uuid4().hex[:12]
    out_filename = req.filename or f"export-{job_id}.mp4"
    if not out_filename.lower().endswith(".mp4"):
        out_filename += ".mp4"
    out_path = EXPORTS / f"{job_id}.mp4"

    jobs[job_id] = {
        "status": "queued",
        "filename": out_filename,
        "progress": 0.0,
    }
    cw, ch = _even(req.canvas.w), _even(req.canvas.h)
    bg.add_task(run_export, job_id, out_path,
                [s.model_dump() for s in req.segments],
                [m.model_dump() for m in req.music],
                cw, ch)
    return {"job_id": job_id}


@app.get("/api/export/{job_id}")
async def export_status(job_id: str):
    if job_id not in jobs:
        raise HTTPException(404)
    return jobs[job_id]


@app.get("/api/download/{job_id}")
async def download(job_id: str):
    out_path = EXPORTS / f"{job_id}.mp4"
    if not out_path.exists():
        raise HTTPException(404)
    # If job is in memory, use the original filename. Otherwise fall back to
    # job_id.mp4 so downloads still work after a service restart.
    filename = jobs.get(job_id, {}).get("filename", f"{job_id}.mp4")
    return FileResponse(
        out_path,
        media_type="video/mp4",
        filename=filename,
    )


class NoCacheStaticFiles(StaticFiles):
    async def get_response(self, path, scope):
        response = await super().get_response(path, scope)
        # Force browser to re-fetch on every load — avoids stale CSS/JS after deploys.
        response.headers["Cache-Control"] = "no-cache, no-store, must-revalidate"
        response.headers["Pragma"] = "no-cache"
        response.headers["Expires"] = "0"
        return response


app.mount("/", NoCacheStaticFiles(directory=str(BASE / "static"), html=True), name="static")
