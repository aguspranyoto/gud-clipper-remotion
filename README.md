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

9:16 full-bleed crop that follows the tracked speaker's face (cut on speaker change, split-screen on talk-over), Hormozi-style word captions (active = yellow pop, keywords = cyan), hook title card over the first 1.2s, progress bar, zoom punches on keywords/punchlines, optional b-roll cutaways, grade + grain + vignette on top.

Motion craft rules come from the `remotion-motion-graphics` skill — read it before touching any Remotion code.
