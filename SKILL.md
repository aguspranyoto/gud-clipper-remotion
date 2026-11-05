---
name: gud-clipper-remotion
description: Turn a YouTube podcast video into 1-10 viral vertical shorts (YouTube Shorts, TikTok, Reels) with Remotion. Use this skill EVERY time the user mentions clipping a podcast, making shorts/tiktoks/reels from a video, "potong podcast jadi shorts", viral moments, or invokes /gud-clipper-remotion with a YouTube URL — even if they don't say the word "clip". Indonesian and English conversations supported.
---

# gud-clipper-remotion

YouTube podcast URL in, 1–10 finished vertical videos out. Priority is **clip quality, retention, and viral potential** — never random splits.

## 0. Parse input

Expected: `/gud-clipper-remotion <youtube_url> output <N>`

- `<youtube_url>`: youtube.com/watch, youtu.be, or /shorts link.
- `N`: integer 1–10. Outside that range → ask for a correction, don't guess.
- Missing pieces → ask for them, don't proceed half-blind.

## 1. Bootstrap the studio (once per project)

The render project lives in `./studio`. If it has no `package.json`, copy the template and install:

```powershell
Copy-Item -Recurse <skill>/assets/studio ./studio
New-Item -ItemType Directory -Force ./studio/scripts | Out-Null
Copy-Item <skill>/scripts/* ./studio/scripts/
cd studio; npm install
pip install opencv-python
```
(bash: `cp -r <skill>/assets/studio ./studio; cp <skill>/scripts/* ./studio/scripts/; pip install opencv-python`)

Needs on PATH: `yt-dlp`, `ffmpeg`/`ffprobe`, `node`, `python` (+ `opencv-python` for face detect; without it clips fall back to static crop — nothing breaks).

Before writing or touching ANY Remotion code, read the **`remotion-motion-graphics`** skill — its 10 non-negotiable rules (no linear easing, spring entrances, 5-layer stack, theme object, mandatory render→stills→verify loop) apply to every composition here.

## 2. Download + metadata

```powershell
New-Item -ItemType Directory -Force source | Out-Null
yt-dlp --print "%(title)s | %(duration)s sec | %(thumbnail)s" "<url>"
yt-dlp -f "bv*[height<=1080]+ba/b[height<=1080]/b" --merge-output-format mp4 \
  -o "source/full.%(ext)s" "<url>"
```

## 3. Transcribe with word timestamps

Local Whisper is the default (free, ID + EN, no API key):

```bash
ffmpeg -y -i source/full.mp4 -vn -ar 16000 -ac 1 source/audio.wav
whisper source/audio.wav --model medium --language auto \
  --word_timestamps True --output_format json -o source/
# produces source/audio.json (whisper verbose_json shape)
```

Alternative: ElevenLabs Scribe with `diarize=true`, exported as JSON with `segments[]`. Both shapes are accepted downstream — `make-clip-props.mjs` normalizes either into:

```json
{ "segments": [{ "text": "...", "start_time": 12.3, "end_time": 18.1,
  "speaker": "Speaker 0", "words": [{ "text": "Halo", "start_time": 12.3, "end_time": 12.6 }] }] }
```

`start`/`end` are accepted as aliases. Segments without `words[]` get uniform timing across their span — but if NO words exist anywhere, stop and re-transcribe with word timestamps; guessing sync is worse than no clip.

## 4. Viral moment detection (you, the model — the core step)

Read the full transcript. Score candidate moments 1–5 on each:

- **Hook strength** — does the first 3 seconds stop a scroller?
- **Surprise / controversy** — bold claim, hot take, plot twist.
- **Insight density** — facts or frameworks worth saving/sharing.
- **Emotion** — confession, conflict, laughter, awe.
- **Humor / relatability** — quotable, meme-able, "that's so true".
- **Opinion / debate** — takes sides, invites comments.
- **Revelation** — behind-the-scenes, money/numbers, untold story.

Selection rules:

- Exactly N clips, non-overlapping, topically diverse (no two clips same story).
- 30–90s each (hard limits: 15s min, 180s max). Reject overlong rambles.
- Each clip **self-contained**: needs zero prior context to land.
- Trim `start` to the hook line — the punch must hit within 3s of the clip opening.
- Write `source/clips.json` — one object per clip. `title`/`start`/`end` required; the rest optional:

```json
[{ "title": "Dia rugi 800 juta dalam 3 hari",
   "start": 1234.5, "end": 1298.0,
   "hook_text": "gue rugi delapan ratus juta dalam tiga hari",
   "why_viral": "revelation 5 + hook 4: angka spesifik + cold-open di klaim",
   "focus": "center",
   "hook": "RUGI 800 JUTA DALAM 3 HARI",
   "keywords": ["delapan ratus juta", "bangkrut"],
   "punchlines": [1261.0],
   "broll": [{ "file": "public/broll/chart.png", "at": 1252.0, "dur": 4 }] }]
```

Field guide:

- `focus` (`left`/`center`/`right`, default `center`) — static-crop fallback when face detect finds no face. Otherwise the camera follows the tracked face automatically; set this anyway as insurance.
- `hook` — 3–8 kata, ALL CAPS di render, max 60 chars. Default = `title`. Kosongkan (`""`) untuk mematikan hook title di clip itu.
- `keywords` — kata/frasa yang di-highlight cyan + di-zoom-punch. Pilih angka, nominal, nama, dan kata emosional ("bangkrut", "selingkuh", "gila"). Max ~6 per clip; lebih dari itu = semuanya jadi tidak spesial.
- `punchlines` — timestamp sumber (detik) untuk zoom punch manual, misal pas ketawa meledak atau gestur. Keyword hits otomatis jadi punch juga.
- `broll` — cutaway di atas footage (audio interview tetap jalan). `file` relatif ke studio root (`public/broll/...`), `at` timestamp sumber, `dur` detik (default 3). Gambar = Ken Burns push-in; mp4/mov/webm = muted. Siapkan file-nya dulu (screenshot, chart, foto) — skill ini tidak men-download-kan B-roll. Bahas angka/chart → screenshot chart-nya; bahas tempat/orang → foto-nya; tidak ada visual relevan → kosongkan saja.

## 5. Cut + build props (shots, faces, punches, hook, b-roll)

```bash
cd studio
node scripts/make-clip-props.mjs \
  --transcript ../source/audio.json \
  --clips ../source/clips.json \
  --src ../source/full.mp4
```

Alur per clip (deterministik — jangan hand-roll): potong `public/clips/clip-N.mp4` via ffmpeg, lalu `scripts/detect-faces.py` jalan otomatis (offline: Haar cascade bawaan opencv, tracking centroid, mouth-motion scoring → petakan speaker ke wajah → deteksi talk-over). Gagal (no python/cv2) → fallback crop statis pakai `focus`, tidak ada yang rusak. `--no-faces` untuk skip eksplisit, `--python py` kalau binary python lu beda nama.

Dari situ script membangun: **shots** (ganti speaker = cut ke wajahnya; talk-over 1s+ = split screen atas-bawah; gap = ikut shot sebelumnya), **captions** (potong di akhir kalimat, ≤8 kata, split di jeda >0.8s, keyword = cyan + punch), **hook**, **progress**, **b-roll**. Nulis `videos/clip-N.json` dan print perintah render. Sanity: `node scripts/make-clip-props.mjs --selftest`, `python scripts/detect-faces.py --selftest`.

## 6. Render + VERIFY (mandatory)

```bash
npx remotion render src/index.ts Clip out/clip-1.mp4 \
  --props=videos/clip-1.json --codec h264 --crf 17 --overwrite
npx remotion still src/index.ts Clip out/check_1.png \
  --props=videos/clip-1.json --frame 45 --overwrite
```

Per the motion-graphics skill: extract stills at 3–4 frames per clip and LOOK at them — include one frame inside a split-screen range and one on a punch/keyword if the clip has them. Fix list in frequency order: face cropped out or camera on the wrong person (`faces-N.json` `faceMap` tells you who mapped where; override via `focus` won't help — fix by re-checking the segment speakers), caption overflow past safe area (critical content stays in middle 75% vertically — platform UI eats top/bottom), hook title overlapping faces, b-roll covering the active speaker's mouth, flat/ugly frame (grade+grain are already stacked — check they are). Re-render, re-inspect. Never deliver an unverified render. First render downloads a Chrome Headless Shell (~150 MB); if blocked, `REMOTION_BROWSER=<path>` or `--browser-executable=<path>`.

## 7. Deliver

For each clip: the `out/clip-N.mp4` path, duration, 1080×1920, plus a table of title / hook / why-viral. Report total runtime. Done.
