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

## 1. Slug + bootstrap the studio (once per video)

The studio template is shared — only outputs get a slug. Derive `SLUG`
from the video title first: lowercase, words joined with hyphens, first
4–6 meaningful words only, max ~40 chars, drop junk (`|`, `PODCAST`,
episode numbers, emoji). Example:
`Ngobrol Santai Bareng Monyet Alfa | Podkesmas #12` → `ngobrol-monyet-alfa`.

Per-video outputs live under that slug inside the FIXED folders:

```
source/<slug>/       # full.mp4, audio.wav/json, clips.json, faces-<slug>-N.json
studio/
  public/clips/<slug>/   # cut clip-N.mp4
  public/broll/<slug>/   # fetched b-roll for this video
  videos/<slug>/         # clip-N.json props
  out/<slug>/            # final clip-N.mp4 + check stills
```

If `source/<slug>` already exists, append `-2`, `-3`.

```powershell
yt-dlp --print "%(title)s" "<url>"
# derive SLUG from the title above, then:
Copy-Item -Recurse <skill>/assets/studio ./studio
New-Item -ItemType Directory -Force ./studio/scripts | Out-Null
Copy-Item <skill>/scripts/* ./studio/scripts/
cd studio; npm install
pip install opencv-python
```
(bash: `SLUG=...; cp -r <skill>/assets/studio ./studio; cp <skill>/scripts/* ./studio/scripts/; pip install opencv-python`)

Needs on PATH: `yt-dlp`, `ffmpeg`/`ffprobe`, `node`, `python` (+ `opencv-python` for face detect; without it clips fall back to static crop — nothing breaks).

Before writing or touching ANY Remotion code, read the **`remotion-motion-graphics`** skill — its 10 non-negotiable rules (no linear easing, spring entrances, 5-layer stack, theme object, mandatory render→stills→verify loop) apply to every composition here.

## 2. Download + metadata

One slug folder per video — pass the SAME slug to everything downstream:

```powershell
$SLUG = "ngobrol-monyet-alfa"  # from step 1
New-Item -ItemType Directory -Force source/$SLUG | Out-Null
yt-dlp --print "%(title)s | %(duration)s sec | %(uploader)s | %(thumbnail)s" "<url>"
yt-dlp -f "bv*[height<=1080]+ba/b[height<=1080]/b" --merge-output-format mp4 \
  -o "source/$SLUG/full.%(ext)s" "<url>"
```

Note the uploader/channel name from the first print — you will pass it as
`--source` to `make-clip-props.mjs` so every clip carries `SUMBER : NAME`.

## 3. Transcribe with word timestamps

Local Whisper is the default (free, ID + EN, no API key):

```bash
ffmpeg -y -i source/$SLUG/full.mp4 -vn -ar 16000 -ac 1 source/$SLUG/audio.wav
whisper source/$SLUG/audio.wav --model medium --language auto \
  --word_timestamps True --output_format json -o source/$SLUG/
# produces source/<slug>/audio.json (whisper verbose_json shape)
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
- Write `source/<slug>/clips.json` — one object per clip. `title`/`start`/`end` required; the rest optional:

```json
[{ "title": "Dia rugi 800 juta dalam 3 hari",
   "start": 1234.5, "end": 1298.0,
   "source": "Rockaromaid",
   "hook_text": "gue rugi delapan ratus juta dalam tiga hari",
   "why_viral": "revelation 5 + hook 4: angka spesifik + cold-open di klaim",
   "focus": "center",
   "keywords": ["delapan ratus juta", "bangkrut"],
   "punchlines": [1261.0],
   "broll": [{ "file": "public/broll/monyet.jpg", "at": 1252.0, "dur": 8 }] }]
```

Field guide:

- `source` — channel/uploader name for the `SUMBER : NAME` label (default from `--source`). One name, uppercase at render.
- `focus` (`left`/`center`/`right`, default `center`) — static-crop fallback when face detect finds no face. The render frames wide on purpose (co-hosts stay in frame), so this is only insurance — with face data the camera follows loosely, never face-zoom.
- `keywords` — kata/frasa yang di-highlight kuning + di-zoom-punch. Pilih angka, nominal, nama, dan kata emosional ("bangkrut", "selingkuh", "gila"). Max ~6 per clip; lebih dari itu = semuanya jadi tidak spesial.
- `punchlines` — timestamp sumber (detik) untuk zoom punch manual, misal pas ketawa meledak atau gestur. Keyword hits otomatis jadi punch juga.
- `broll` — cutaway di panel bawah 65/35 (audio interview tetap jalan). `file` boleh ditulis bebas (`public/broll/monyet.jpg` atau `broll/x.jpg` — script menormalkan ke `public/broll/<slug>/`), `at` timestamp sumber, `dur` detik. Tambah `"full": true` untuk full-frame (close-up lucu/reaksi). Gambar = diulang dengan Ken Burns drift; mp4/mov/webm = muted. Siapkan file-nya dulu dari internet ke `studio/public/broll/<slug>/` — skill ini tidak men-download-kan B-roll.
  - JANGAN PERNAH pakai screenshot/foto dari video podcast-nya sendiri (host, co-host, narsum, studio) sebagai b-roll — kecuali yang dibahas MEMANG orang itu secara spesifik. Kalau ragu → kosongkan saja (clip jadi full speaker).
  - 1 topik = 1 gambar. Kalau clip 30 detik bahas 1 hal, pakai SATU gambar sepanjang span itu (perpanjang `dur` / ulang), JANGAN karang gambar ke-2/ke-3 yang nggak nyambung cuma buat ngisi.
  - Gambar harus menggambarkan apa yang DIOMONGIN di rentang `[at, at+dur)` itu persis — cek kata benda di transkrip vs isi gambar. Bahas monyet → foto monyet; bahas KPK → gedung KPK / borgol / sidang; bahas angka/chart → screenshot chart-nya. Nggak ada visual yang cocok → kosongkan.

B-roll coverage: SATU gambar per topik — perpanjang `dur` untuk cover
span yang bahas hal yang sama (boleh full clip kalau topiknya satu).
Jangan karang gambar tambahan yang nggak nyambung cuma buat ngisi;
full-frame `full: true` allowed untuk 1–2 momen punch. Kosong = clip
jadi full speaker, itu valid.

## 5. Cut + build props (wide shots, faces, punches, 1-line captions, b-roll)

```bash
cd studio
node scripts/make-clip-props.mjs \
  --transcript ../source/$SLUG/audio.json \
  --clips ../source/$SLUG/clips.json \
  --src ../source/$SLUG/full.mp4 \
  --source "NamaChannel" \
  --slug $SLUG
```

Alur per clip (deterministik — jangan hand-roll): potong `public/clips/<slug>/clip-N.mp4` via ffmpeg, lalu `scripts/detect-faces.py` jalan otomatis (offline: Haar cascade bawaan opencv, tracking centroid, mouth-motion scoring → petakan speaker ke wajah → deteksi talk-over) → faces ke `source/<slug>/faces-<slug>-N.json`. Gagal (no python/cv2) → fallback crop statis lebar pakai `focus`, tidak ada yang rusak. `--no-faces` untuk skip eksplisit, `--python py` kalau binary python lu beda nama.

Dari situ script membangun: **shots** (ganti speaker = cut ringan, framing TETAP wide — tidak pernah split screen; co-host tetap di frame), **captions** (persis 1 baris per kartu, max 3 kata, ALL CAPS condensed — putih, kata aktif/keyword kuning), **source label** (`SUMBER : NAMA` persisten kiri-atas), **zoom punch** (7% pop di keyword/punchline), **b-roll** (panel bawah 65/35; `full: true` = full-frame). `--source` = default label semua clip, per-clip `source` menimpa. Nulis `videos/<slug>/clip-N.json` dan print perintah render (sudah ber-slug: `out/<slug>/clip-N.mp4`). Sanity: `node scripts/make-clip-props.mjs --selftest`, `python scripts/detect-faces.py --selftest`.

## 6. Render + VERIFY (mandatory)

Run from `studio/`:

```bash
cd studio
npx remotion render src/index.ts Clip out/$SLUG/clip-1.mp4 \
  --props=videos/$SLUG/clip-1.json --codec h264 --crf 17 --overwrite
npx remotion still src/index.ts Clip out/$SLUG/check_1.png \
  --props=videos/$SLUG/clip-1.json --frame 45 --overwrite
```

Per the motion-graphics skill: extract stills at 3–4 frames per clip and LOOK at them — include one frame over a b-roll panel and one on a punch/keyword. Fix list in frequency order: two-shot framing too tight (face fills >60% frame height — widen via looser zoom, never face-zoom), speaker torso/gestures cropped out, caption wrapping to 2 lines (cards must be max 3 words — fix in props, not in render), white-on-white illegibility, source label missing/overlapping, b-roll covering the caption seam badly, split-screen appearing at all (there is no split mode anymore — shots stay wide single). Re-render, re-inspect. Never deliver an unverified render. First render downloads a Chrome Headless Shell (~150 MB); if blocked, `REMOTION_BROWSER=<path>` or `--browser-executable=<path>`.

## 7. Deliver

For each clip: the `studio/out/<slug>/clip-N.mp4` path, duration, 1080×1920, plus a table of title / hook / why-viral. Report total runtime. Done.
