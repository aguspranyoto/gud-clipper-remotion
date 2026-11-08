#!/usr/bin/env node
// Cut N viral clips from a podcast source + build Remotion props for the
// "Clip" composition.
//
//   node scripts/make-clip-props.mjs \
//     --transcript ../source/<slug>/audio.json \
//     --clips ../source/<slug>/clips.json \
//     --src ../source/<slug>/full.mp4 \
//     --slug <slug>
//
// --transcript accepts either shape:
//   - ElevenLabs/Scribe: { segments: [{ text, start_time/end_time, speaker,
//     words: [{ text, start_time/end_time }] }] }
//   - Whisper verbose_json: { segments: [{ start, end, text,
//     words: [{ word, start, end }] }] }
// --clips: [{ title, start, end, source?, focus?, keywords?, punchlines?,
//     broll? }] with start/end in source seconds. keywords: ["800 juta"].
//   punchlines: [sourceSec, ...]. broll: [{ file, at, dur, full? }] with
//   `at` in source seconds, `file` relative to the studio root, and
//   `full: true` to take over the whole frame (funny/animal close-up).
//   --source "CHANNEL" sets the persistent "SUMBER : CHANNEL" label
//   (per-clip `source` overrides it).
// --slug <slug> (required): short per-video folder name — the cut clip,
//   faces file, props, and b-roll reference all land under it:
//   public/clips/<slug>/clip-N.mp4, videos/<slug>/clip-N.json, and b-roll
//   paths are rewritten to broll/<slug>/....
//
// Per clip: validates range, cuts public/clips/<slug>/clip-N.mp4 with
// ffmpeg, runs scripts/detect-faces.py (offline Haar + motion; skipped
// with --no-faces or when python/cv2 is missing — falls back to static
// wide crop), builds wide speaker-following shots, 3-word single-line
// caption cards with hot-word highlight, keyword punches, source label,
// and bottom-panel/full b-roll overlays, then writes
// videos/<slug>/clip-N.json and prints the render command. Run from the
// studio root.
//
// Self-check (no ffmpeg/fs needed): node scripts/make-clip-props.mjs --selftest
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

const SENTENCE_END = /[.!?…]["'“”‘’()\]]?$/;
const MAX_WORDS = 3;
const MAX_GAP = 0.8;

const argv = process.argv.slice(2);
async function runSelftest() {
  const { strict: assert } = await import("node:assert");

  // Grouping: sentence end cuts, 3-word cap, 0.8s pause splits.
  const words = (text, t0, step = 0.3) =>
    text.split(" ").map((w, i) => ({
      text: w,
      start: t0 + i * step,
      end: t0 + (i + 1) * step,
    }));
  let caps = groupCaptions(
    words("Halo apa kabar semua teman teman pendengar setia podcast ini", 0),
    30,
  );
  assert.equal(caps.length, 4, "10 words split into 3-word single-line cards");
  assert.equal(caps[0].words.length, 3);

  caps = groupCaptions(words("Serius? Gila sih itu.", 10), 30);
  assert.equal(caps.length, 2, "sentence-end punctuation cuts the card");

  const paused = [...words("satu dua tiga", 0), ...words("empat lima", 5)];
  caps = groupCaptions(paused, 30);
  assert.equal(caps.length, 2, ">0.8s pause splits the card");

  // Frame math: from/duration derive from word times, contiguous hold.
  caps = groupCaptions(words("a b c", 2.0, 0.5), 30);
  assert.equal(caps[0].from, 60, "from = first word start * fps");
  assert.ok(
    caps[0].durationInFrames >= Math.round(1.2 * 30),
    "duration covers last word end",
  );

  // Whisper + ElevenLabs normalization converge to one shape.
  const w = normalizeTranscript({
    segments: [
      {
        start: 1,
        end: 3,
        text: " halo dunia ",
        words: [{ word: " halo", start: 1, end: 2 }],
      },
    ],
  });
  assert.equal(w[0].words[0].text, "halo");
  const e = normalizeTranscript({
    segments: [
      {
        text: "hi",
        start_time: 1,
        end_time: 2,
        speaker: { name: "S1" },
        words: [],
      },
    ],
  });
  assert.equal(e[0].speaker, "S1");
  assert.equal(e[0].words.length, 1, "wordless segment gets uniform timing");

  // Hot keywords: single + multi-word phrase matching.
  const hw = words("dia rugi delapan ratus juta rupiah", 0);
  markHot(hw, ["delapan ratus juta"]);
  assert.deepEqual(
    hw.map((x) => !!x.hot),
    [false, false, true, true, true, false],
    "phrase match marks exactly the phrase words",
  );

  // Shots: speaker change cuts, gaps inherit. Always single wide shots —
  // no split-screen; co-hosts stay in frame via the wide crop.
  const segs = [
    { start: 0, end: 3, speaker: "A" },
    { start: 3, end: 6, speaker: "B" },
  ];
  let shots = buildShots(segs, { A: 0, B: 1 }, 180, 30);
  assert.equal(shots.length, 2, "speaker change cuts the shot");
  assert.deepEqual(
    shots.map((s) => s.face),
    [0, 1],
  );
  assert.ok(
    shots.every((s) => s.mode === "single"),
    "no split mode — always a single wide shot",
  );
  shots = buildShots(
    [
      { start: 0, end: 4, speaker: "A" },
      { start: 2, end: 6, speaker: "B" },
    ],
    { A: 0, B: 1 },
    180,
    30,
  );
  assert.ok(
    shots.every((s) => s.mode === "single"),
    "talk-over stays a single wide shot, never a split",
  );
  shots = buildShots([{ start: 2, end: 4, speaker: "A" }], { A: 0 }, 180, 30);
  assert.ok(
    shots.every((s) => s.face === 0),
    "leading/trailing gaps inherit the face",
  );
  shots = buildShots(segs, {}, 180, 30);
  assert.deepEqual(
    shots.map((s) => s.face),
    [-1],
    "no face map falls back to static crop",
  );

  // Slug validation: lowercase words-with-hyphens, max 40 chars.
  assert.ok(checkSlug("ngobrol-monyet-alfa"), "valid slug passes");
  assert.ok(!checkSlug(""), "empty slug rejected");
  assert.ok(!checkSlug("Monyet Alfa"), "spaces/uppercase rejected");
  assert.ok(!checkSlug("a".repeat(41)), "overlong slug rejected");

  // B-roll rewrite: any input path lands under broll/<slug>/basename.
  assert.equal(
    rewriteBroll("public/broll/monyet.jpg", "ngobrol-monyet-alfa"),
    "broll/ngobrol-monyet-alfa/monyet.jpg",
  );
  assert.equal(
    rewriteBroll("broll/old-slug/monyet.jpg", "ngobrol-monyet-alfa"),
    "broll/ngobrol-monyet-alfa/monyet.jpg",
  );

  console.log("selftest: all assertions passed");
}

if (argv.includes("--selftest")) {
  await runSelftest();
  process.exit(0);
}

const flag = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  return i === -1 ? fallback : argv[i + 1];
};

const transcriptFile = flag("transcript");
const clipsFile = flag("clips");
const srcFile = flag("src");
const fps = Number(flag("fps", 30));
const noFaces = argv.includes("--no-faces");
const pythonBin = flag("python", "python");
const defaultSource = flag("source", "");
const slug = flag("slug", "");
for (const [file, label] of [
  [transcriptFile, "--transcript"],
  [clipsFile, "--clips"],
  [srcFile, "--src"],
]) {
  if (!file || !existsSync(file)) {
    console.error(`Missing or unreadable ${label} <file>`);
    process.exit(1);
  }
}
if (!checkSlug(slug)) {
  console.error(
    "Missing or bad --slug <slug> (lowercase words-with-hyphens, max 40 chars).",
  );
  process.exit(1);
}

const readJson = (file) =>
  JSON.parse(readFileSync(file, "utf8").replace(/^﻿/, ""));
function num(v) {
  return typeof v === "number" ? v : Number(v);
}

// Transcript normalization: every accepted shape becomes
// [{ text, start, end, speaker, words: [{ text, start, end }] }].
function normalizeTranscript(json) {
  const segments = Array.isArray(json.segments) ? json.segments : [];
  return segments.flatMap((seg) => {
    const text = String(seg.text ?? "").trim();
    const start = num(seg.start_time ?? seg.start);
    const end = num(seg.end_time ?? seg.end);
    if (!text || !Number.isFinite(start)) return [];
    const rawWords = Array.isArray(seg.words) ? seg.words : [];
    let words = rawWords
      .map((w) => ({
        text: String(w.text ?? w.word ?? "").trim(),
        start: num(w.start_time ?? w.start),
        end: num(w.end_time ?? w.end),
      }))
      .filter((w) => w.text && Number.isFinite(w.start));
    if (words.length === 0 && Number.isFinite(end) && end > start) {
      // Wordless segment: spread words uniformly so captions still sync.
      const parts = text.split(/\s+/);
      words = parts.map((word, i) => ({
        text: word,
        start: start + ((end - start) * i) / parts.length,
        end: start + ((end - start) * (i + 1)) / parts.length,
      }));
    }
    const speaker =
      typeof seg.speaker === "string"
        ? seg.speaker
        : seg.speaker?.name || seg.speaker?.id || "Speaker";
    return [{ text, start, end, speaker, words }];
  });
}

// Pure: flat word list (absolute source seconds) -> single-line caption
// cards, max 3 words each. One line only — cards never wrap; the render
// keeps each card on exactly one line at the 65/35 seam.
function groupCaptions(words, fps) {
  const cards = [];
  let cur = null;
  const flush = () => {
    if (cur && cur.words.length > 0) {
      const from = Math.round(cur.words[0].start * fps);
      const lastEnd = cur.words[cur.words.length - 1].end;
      const to = Math.max(
        from + 1,
        Math.round(
          (Number.isFinite(lastEnd) ? lastEnd : cur.words[0].start + 0.5) *
            fps,
        ) + 6,
      );
      cards.push({ from, durationInFrames: to - from, words: cur.words });
    }
    cur = null;
  };
  for (const w of words) {
    cur ??= { words: [] };
    const prev = cur.words[cur.words.length - 1];
    if (prev && w.start - prev.end > MAX_GAP) flush();
    cur ??= { words: [] };
    cur.words.push(w);
    if (SENTENCE_END.test(w.text) || cur.words.length >= MAX_WORDS) flush();
  }
  flush();
  // Hold each card until the next starts so captions never flash blank.
  for (let i = 0; i + 1 < cards.length; i++) {
    const next = cards[i + 1].from;
    if (next > cards[i].from) cards[i].durationInFrames = next - cards[i].from;
  }
  return cards;
}

function cleanToken(s) {
  return String(s ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9À-ɏḀ-ỿ]/gi, "");
}

// Pure: slug + b-roll path helpers (also asserted in --selftest).
function checkSlug(slug) {
  return (
    /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug) && String(slug).length <= 40
  );
}
function rewriteBroll(rel, slug) {
  const stripped = String(rel ?? "")
    .replace(/\\/g, "/")
    .replace(/^public\//, "");
  const under = stripped.startsWith("broll/")
    ? stripped.slice("broll/".length).replace(/^[^/]+\//, "")
    : stripped.replace(/^.*\//, "");
  return `broll/${slug}/${under}`;
}

// Pure: flag words matching any keyword phrase (mutates words, returns them).
function markHot(words, keywords) {
  const phrases = (Array.isArray(keywords) ? keywords : [])
    .map((k) => String(k).split(/\s+/).map(cleanToken).filter(Boolean))
    .filter((p) => p.length > 0);
  if (phrases.length === 0) return words;
  const toks = words.map((w) => cleanToken(w.text));
  for (const phrase of phrases) {
    for (let i = 0; i + phrase.length <= toks.length; i++) {
      if (phrase.every((t, k) => toks[i + k] === t)) {
        for (let k = 0; k < phrase.length; k++) words[i + k].hot = true;
      }
    }
  }
  return words;
}

// Pure: speaker timeline -> wide single shots. Gaps inherit the previous
// face; sub-second fragments merge; no face map -> static wide crop.
// Never splits: co-hosts stay in frame via the loose wide framing.
function buildShots(clipSegs, faceMap, totalFrames, fps) {
  const faceOf = (sp) => {
    const f = faceMap?.[sp];
    return Number.isInteger(f) && f >= 0 ? f : -1;
  };

  const bounds = new Set([0, totalFrames]);
  const push = (sec) =>
    bounds.add(Math.min(totalFrames, Math.max(0, Math.round(sec * fps))));
  for (const s of clipSegs) {
    push(s.start);
    push(s.end);
  }
  const edges = [...bounds].sort((a, b) => a - b);

  const raw = [];
  for (let i = 0; i + 1 < edges.length; i++) {
    const from = edges[i];
    const dur = edges[i + 1] - from;
    if (dur <= 0) continue;
    const t = from / fps + dur / fps / 2;
    const active = clipSegs.filter((s) => s.start <= t && t < s.end);
    if (active.length > 0) {
      raw.push({
        from,
        durationInFrames: dur,
        mode: "single",
        face: faceOf(active[0].speaker),
      });
    } else {
      raw.push({ from, durationInFrames: dur, mode: "single", face: null });
    }
  }

  // Gaps inherit the nearest face (previous shot, or the next one for
  // leading gaps so the cold open already frames the upcoming speaker);
  // merge identical neighbours; absorb sub-second fragments.
  const merged = [];
  for (let k = 0; k < raw.length; k++) {
    let face = raw[k].face;
    if (face === null) {
      face = merged.at(-1)?.face;
      if (face == null || face === undefined) {
        // Leading gap: no previous shot yet — look ahead to the next face.
        face = raw.slice(k + 1).find((s) => s.face !== null)?.face ?? -1;
      }
    }
    const s = raw[k];
    const cur = { ...s, face };
    const prev = merged.at(-1);
    if (
      prev &&
      prev.mode === cur.mode &&
      prev.face === cur.face &&
      prev.from + prev.durationInFrames === cur.from
    ) {
      prev.durationInFrames += cur.durationInFrames;
    } else if (
      prev &&
      cur.durationInFrames < fps &&
      prev.from + prev.durationInFrames === cur.from
    ) {
      prev.durationInFrames += cur.durationInFrames;
    } else {
      merged.push(cur);
    }
  }
  if (merged.length === 0) {
    merged.push({ from: 0, durationInFrames: totalFrames, mode: "single", face: -1 });
  }
  merged[merged.length - 1].durationInFrames =
    totalFrames - merged[merged.length - 1].from;
  return merged;
}

const timedSegs = normalizeTranscript(readJson(transcriptFile));
if (timedSegs.length === 0) {
  console.error(
    "Transcript has no usable segments. Re-transcribe with word timestamps.",
  );
  process.exit(1);
}
const allWords = timedSegs.flatMap((s) => s.words);

let clips;
try {
  clips = readJson(clipsFile);
} catch {
  console.error("Could not parse --clips JSON (expected an array).");
  process.exit(1);
}
if (!Array.isArray(clips) || clips.length < 1 || clips.length > 10) {
  console.error(
    `Expected 1-10 clips, got ${Array.isArray(clips) ? clips.length : "non-array"}.`,
  );
  process.exit(1);
}

const probe = (args, label) => {
  try {
    return execFileSync("ffprobe", args, { encoding: "utf8" }).trim();
  } catch {
    console.warn(`ffprobe ${label} failed — using fallback.`);
    return "";
  }
};
let srcDuration = Number(
  probe(
    ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", srcFile],
    "duration",
  ),
);
if (!Number.isFinite(srcDuration)) srcDuration = NaN;
let srcWidth = Number(
  probe(
    ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width", "-of", "csv=p=0", srcFile],
    "width",
  ),
);
let srcHeight = Number(
  probe(
    ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=height", "-of", "csv=p=0", srcFile],
    "height",
  ),
);
if (!Number.isFinite(srcWidth) || srcWidth <= 0) srcWidth = 1920;
if (!Number.isFinite(srcHeight) || srcHeight <= 0) srcHeight = 1080;

const FOCUS = new Set(["left", "center", "right"]);
const facesDir = dirname(resolve(transcriptFile));
clips.forEach((clip, i) => {
  const n = i + 1;
  const start = num(clip.start);
  const end = num(clip.end);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) {
    console.error(`Clip ${n}: need start < end in source seconds.`);
    process.exit(1);
  }
  const dur = end - start;
  if (dur < 15 || dur > 180) {
    console.warn(`Clip ${n}: ${dur.toFixed(1)}s outside the 30-90s sweet spot.`);
  }
  if (Number.isFinite(srcDuration) && (start < 0 || end > srcDuration + 1)) {
    console.error(
      `Clip ${n}: range outside source (0-${srcDuration.toFixed(1)}s).`,
    );
    process.exit(1);
  }

  const padStart = Math.max(0, start - 0.3); // hook breathing room
  // Don't clip the last syllable — but never run past the source itself.
  const padEnd =
    Number.isFinite(srcDuration) && srcDuration > 0
      ? Math.min(end + 0.4, srcDuration)
      : end + 0.4;
  const clipDur = padEnd - padStart;
  const totalFrames = Math.round(clipDur * fps);

  const outClip = resolve(join("public", "clips", slug, `clip-${n}.mp4`));
  mkdirSync(dirname(outClip), { recursive: true });
  try {
    execFileSync("ffmpeg", [
      "-y",
      "-ss",
      String(padStart),
      "-i",
      resolve(srcFile),
      "-t",
      String(clipDur),
      "-c:v",
      "libx264",
      "-preset",
      "veryfast",
      "-crf",
      "18",
      "-c:a",
      "aac",
      "-movflags",
      "+faststart",
      outClip,
    ]);
  } catch {
    console.error(`Clip ${n}: ffmpeg cut failed. Is ffmpeg on PATH?`);
    process.exit(1);
  }

  // Face detect on the cut clip (offline). Any failure -> static crop.
  let faceData = null;
  const facesFile = join(facesDir, `faces-${slug}-${n}.json`);
  if (!noFaces) {
    try {
      execFileSync(
        pythonBin,
        [
          resolve(join("scripts", "detect-faces.py")),
          "--video",
          outClip,
          "--transcript",
          resolve(transcriptFile),
          "--start",
          String(start),
          "--end",
          String(end),
          "--offset",
          String(padStart),
          "--out",
          facesFile,
        ],
        { stdio: "pipe" },
      );
      faceData = readJson(facesFile);
    } catch {
      console.warn(
        `Clip ${n}: face detect failed (need python + opencv-python) — static crop fallback.`,
      );
    }
  }
  const faceMap =
    faceData && typeof faceData.faceMap === "object" ? faceData.faceMap : {};
  // Sanity: a mapped track must actually appear in the faces samples and
  // cover the clip (present in >=50% of sample frames). Ghost tracks from
  // grid/cut re-detections map the narrator off-frame and slice the real
  // speaker out — drop them back to the static wide crop.
  if (faceData?.faces?.length) {
    const present = {};
    for (const s of faceData.faces) {
      for (const b of s.boxes ?? []) {
        present[b.track] = (present[b.track] ?? 0) + 1;
      }
    }
    const need = faceData.faces.length * 0.5;
    for (const [sp, tr] of Object.entries(faceMap)) {
      if (!Number.isInteger(tr) || (present[tr] ?? 0) < need) {
        console.warn(
          `Clip ${n}: face track ${tr} for "${sp}" covers too few frames — static wide crop fallback.`,
        );
        delete faceMap[sp];
      }
    }
  }

  const clipSegs = timedSegs
    .filter((s) => s.end > padStart && s.start < padEnd)
    .map((s) => ({
      start: Math.max(0, s.start - padStart),
      end: Math.max(0, Math.min(s.end, padEnd) - padStart),
      speaker: s.speaker,
    }));
  const shots = buildShots(clipSegs, faceMap, totalFrames, fps);

  const words = allWords
    .filter((w) => w.start >= padStart && w.start < padEnd)
    .map((w) => ({
      text: w.text,
      start: Math.max(0, w.start - padStart),
      end: Math.max(
        0,
        (Number.isFinite(w.end) ? w.end : w.start + 0.3) - padStart,
      ),
    }));
  if (words.length === 0) {
    console.error(`Clip ${n}: no transcript words in range — check start/end.`);
    process.exit(1);
  }
  markHot(words, clip.keywords);
  const captions = groupCaptions(words, fps);
  captions[captions.length - 1].durationInFrames = Math.max(
    1,
    totalFrames - captions[captions.length - 1].from,
  );

  // Punch zooms: explicit punchlines + first word of each keyword hit.
  const punches = new Set();
  for (const p of Array.isArray(clip.punchlines) ? clip.punchlines : []) {
    const local = num(p) - padStart;
    if (local >= 0 && local <= clipDur) punches.add(local);
  }
  for (const w of words) {
    if (w.hot && punches.size < 6) punches.add(w.start);
  }
  const punchTimes = [...punches].sort((a, b) => a - b);

  // B-roll cutaways (audio stays on the interview). Default fills the
  // bottom 35% under the speaker; full: true takes the whole frame
  // (meme close-up, animal reaction) — captions stay on top regardless.
  // Files live under public/broll/<slug>/ and are rewritten to the
  // staticFile-relative path broll/<slug>/....
  const broll = [];
  for (const b of Array.isArray(clip.broll) ? clip.broll : []) {
    let rel = String(b.file ?? "");
    // Fallback: the model prepared public/broll/<slug>/file but wrote a
    // generic path in clips.json — resolve the basename under the slug.
    if (rel && !existsSync(resolve(rel))) {
      const underSlug = join("public", "broll", slug, basename(rel));
      if (existsSync(resolve(underSlug))) rel = underSlug;
    }
    if (!rel || !existsSync(resolve(rel))) {
      console.warn(`Clip ${n}: b-roll missing, skipped: ${rel}`);
      continue;
    }
    const from = Math.round((num(b.at) - padStart) * fps);
    const len = Math.round(num(b.dur ?? 3) * fps);
    if (!Number.isFinite(from) || !Number.isFinite(len) || len <= 0) continue;
    const clampedFrom = Math.min(Math.max(0, from), totalFrames - 1);
    broll.push({
      from: clampedFrom,
      durationInFrames: Math.min(len, totalFrames - clampedFrom),
      file: rewriteBroll(rel, slug),
      kind: /\.(mp4|mov|webm)$/i.test(rel) ? "video" : "image",
      ...(b.full ? { full: true } : {}),
    });
  }

  // Persistent source credit: overridden per clip, else --source, else the
  // yt-dlp channel/uploader piped through the clips file.
  const srcName = String(clip.source ?? defaultSource ?? "").trim();
  const props = {
    fps,
    width: 1080,
    height: 1920,
    durationInFrames: totalFrames,
    clip: `clips/${slug}/clip-${n}.mp4`,
    title: String(clip.title ?? `Clip ${n}`),
    ...(srcName ? { sourceLabel: `SUMBER : ${srcName.toUpperCase()}` } : {}),
    focus: FOCUS.has(clip.focus) ? clip.focus : "center",
    srcWidth,
    srcHeight,
    shots,
    ...(faceData?.faces
      ? { faces: { sampleFps: faceData.sampleFps ?? 5, samples: faceData.faces } }
      : {}),
    ...(punchTimes.length > 0 ? { punchTimes } : {}),
    ...(broll.length > 0 ? { broll } : {}),
    captions,
  };
  const outProps = resolve(join("videos", slug, `clip-${n}.json`));
  mkdirSync(dirname(outProps), { recursive: true });
  writeFileSync(outProps, `${JSON.stringify(props, null, 2)}\n`);

  const feats = [
    `${shots.length} shots`,
    faceData ? `${Object.keys(faceMap).length} faces mapped` : "static crop",
    punchTimes.length > 0 ? `${punchTimes.length} punches` : null,
    broll.length > 0 ? `${broll.length} b-roll` : null,
  ]
    .filter(Boolean)
    .join(", ");
  console.log(
    `Clip ${n}: "${props.title}" ${clipDur.toFixed(1)}s, ${totalFrames}f, ${captions.length} captions (${feats})`,
  );
  console.log(
    `  Render: npx remotion render src/index.ts Clip out/${slug}/clip-${n}.mp4 --props=videos/${slug}/clip-${n}.json --codec h264 --crf 17 --overwrite`,
  );
});
