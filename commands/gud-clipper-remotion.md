---
description: Clip a YouTube podcast into 1-10 viral vertical shorts with Remotion
argument-hint: <youtube_url> output <1-10>
---

Parse `$ARGUMENTS` as `<youtube_url> output <N>` (e.g. `/gud-clipper-remotion https://www.youtube.com/watch?v=VIDEO_ID output 5`).

- N must be an integer 1–10. Anything else → ask the user to correct it.
- Missing URL or N → ask for what's missing.

Then follow the `gud-clipper-remotion` skill workflow end to end (SKILL.md): download → transcribe → viral detection → cut → render → verify → deliver.
