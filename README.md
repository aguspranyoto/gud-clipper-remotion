# gud-clipper-remotion

YouTube podcast URL in, 1–10 finished vertical shorts out. Remotion composition + word-synced Hormozi-style captions, 1080×1920 for Shorts/TikTok/Reels.

## Install

Claude Code skill. Drop this folder where your skills live and invoke:

```
/gud-clipper-remotion <youtube_url> output <1-10>
```

## Requires on PATH

`yt-dlp`, `ffmpeg`/`ffprobe`, `node` + `npm`, `python` (+ `pip install opencv-python` for offline face detect; without it clips fall back to static crop).

## Layout

```
SKILL.md                    # the workflow (download → transcribe → detect → cut → render → verify)
commands/gud-clipper-remotion.md   # slash-command wrapper
scripts/make-clip-props.mjs # cut clips + build Remotion props (has --selftest)
scripts/detect-faces.py     # offline face detect + speaker mapping + talk-over detection (has --selftest)
assets/studio/              # Remotion project template (ClipVideo + theme + config)
references/viral-rubric.md  # the 7-signal scoring rubric for moment detection
```

## What the render looks like

50/50 vertical split — speaker on top in a wide medium shot (2 people stay
in frame, never zoomed into a face), B-roll image/video on the bottom
(full-frame for funny/animal close-ups). Persistent `SUMBER : CHANNEL`
credit top-left, single-line ALL CAPS condensed captions on the seam
(white, active/keyword word in yellow). No progress bar, no hook card —
the cold-opened hook line is the opener.

Motion craft rules come from the `remotion-motion-graphics` skill — read it before touching any Remotion code.
