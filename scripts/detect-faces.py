#!/usr/bin/env python3
"""Offline face detection + speaking-face mapping for one cut clip.

Samples frames, detects faces with the Haar cascade bundled inside
opencv-python (no model download, fully offline), tracks faces by centroid,
scores mouth-region motion per face, and maps transcript speakers to faces
by motion activity. Times in output are clip-local seconds.

  python scripts/detect-faces.py --video public/clips/clip-1.mp4 \
    --transcript ../source/audio.json --start 1234.5 --offset 1234.2 \
    --out ../source/faces-1.json

--start/--end bound the transcript to the clip's source range; --offset is
the source timestamp of clip-local 0 (i.e. padStart from the cutter).

Self-check, no cv2/video needed: python scripts/detect-faces.py --selftest
"""
# ponytail: Haar cascade misses profiles + extreme angles and jitters on
# small faces. Upgrade path: MediaPipe Face Detection (still offline after
# pip install) if miss rate hurts. Greedy centroid tracking below is O(n^2)
# per sample — fine at <=4 faces, replace with Hungarian matching if raised.
import argparse
import json
import sys

try:
    import cv2
except ImportError:
    cv2 = None

MAX_FACES = 4
MATCH_DIST = 0.12  # max centroid drift (normalized units) between samples
SAMPLE_FPS = 5
SMOOTH_WINDOW = 5  # moving-average samples (~1s): kills Haar jitter offline
TRACK_TTL = 10  # samples before an unseen track dies (~2s)
MIN_OVERLAP = 1.0  # ignore sub-second crosstalk blips


def match_tracks(prev, curr, max_dist=MATCH_DIST):
    """Greedy centroid match. prev: [(id, cx, cy)], curr: [(cx, cy, w, h)].

    Returns track ids aligned with curr; unseen faces get fresh ids."""
    used = set()
    start = max([i for i, _, _ in prev], default=-1) + 1
    ids = []
    for cx, cy, _, _ in curr:
        best, best_d = None, max_dist
        for pid, px, py in prev:
            if pid in used:
                continue
            d = ((cx - px) ** 2 + (cy - py) ** 2) ** 0.5
            if d < best_d:
                best, best_d = pid, d
        if best is None:
            best = start
            start += 1
        used.add(best)
        ids.append(best)
    return ids


def smooth_series(values, window=SMOOTH_WINDOW):
    """Centered moving average; edges use whatever overlaps."""
    out = []
    half = window // 2
    for i in range(len(values)):
        chunk = values[max(0, i - half) : i + half + 1]
        out.append(sum(chunk) / len(chunk))
    return out


def map_speakers(speaker_scores):
    """speaker_scores: {speaker: {track: motion}}. Greedy best-pair assignment
    so two speakers never share one face. Returns {speaker: track | None}."""
    pairs = sorted(
        ((m, sp, tr) for sp, tm in speaker_scores.items() for tr, m in tm.items()),
        reverse=True,
    )
    taken_sp, taken_tr, mapping = set(), set(), {}
    for m, sp, tr in pairs:
        if m <= 0 or sp in taken_sp or tr in taken_tr:
            continue
        mapping[sp] = tr
        taken_sp.add(sp)
        taken_tr.add(tr)
    for sp in speaker_scores:
        mapping.setdefault(sp, None)
    return mapping


def find_overlaps(segments, min_dur=MIN_OVERLAP):
    """segments: [(start, end, speaker)] clip-local. Returns merged ranges
    where 2+ speakers are active (talk-over => split screen)."""
    events = []
    for s, e, _ in segments:
        if e > s:
            events.append((s, 1))
            events.append((e, -1))
    events.sort()
    ranges, depth, cur = [], 0, None
    for t, d in events:
        depth += d
        if depth >= 2 and cur is None:
            cur = t
        elif depth < 2 and cur is not None:
            if t - cur >= min_dur:
                if ranges and cur - ranges[-1][1] < 0.5:
                    ranges[-1][1] = t  # bridge tiny gaps
                else:
                    ranges.append([cur, t])
            cur = None
    return [{"start": s, "end": e} for s, e in ranges]


def load_segments(path):
    """Minimal parse of either transcript shape; only start/end/speaker used."""
    with open(path, encoding="utf-8-sig") as f:
        data = json.load(f)
    out = []
    for s in data.get("segments", []):
        try:
            start = float(s.get("start_time", s.get("start")))
        except (TypeError, ValueError):
            continue
        try:
            end = float(s.get("end_time", s.get("end", start)))
        except (TypeError, ValueError):
            end = start
        sp = s.get("speaker", "Speaker")
        if isinstance(sp, dict):
            sp = sp.get("name") or sp.get("id") or "Speaker"
        out.append((start, end, str(sp)))
    return out


def selftest():
    ids = match_tracks([(0, 0.3, 0.4), (1, 0.7, 0.4)], [(0.31, 0.41, 0.1, 0.2)])
    assert ids == [0], f"continuity broken: {ids}"
    ids = match_tracks([(0, 0.3, 0.4)], [(0.31, 0.41, 0.1, 0.2), (0.8, 0.4, 0.1, 0.2)])
    assert ids == [0, 1], f"new face should get fresh id: {ids}"
    assert smooth_series([0, 0, 10, 0, 0], 3)[2] < 10, "smoothing must damp spikes"
    m = map_speakers({"A": {0: 5.0, 1: 1.0}, "B": {0: 4.0, 1: 3.0}})
    assert m == {"A": 0, "B": 1}, f"greedy distinct assignment failed: {m}"
    m = map_speakers({"A": {0: 0.0}})
    assert m == {"A": None}, "zero-motion speaker must map to None"
    ov = find_overlaps([(0, 5, "A"), (3, 8, "B"), (20, 20.5, "A"), (20.2, 21, "B")])
    assert ov == [{"start": 3, "end": 5}], f"overlap wrong: {ov}"
    print("selftest: all assertions passed")


def main(args):
    if cv2 is None:
        print("detect-faces: opencv-python not installed (pip install opencv-python).",
              file=sys.stderr)
        sys.exit(2)
    segments = [
        (s - args.offset, e - args.offset, sp)
        for s, e, sp in load_segments(args.transcript)
        if e > args.start and s < args.end
    ]

    cap = cv2.VideoCapture(args.video)
    src_fps = cap.get(cv2.CAP_PROP_FPS) or 30
    width = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH))
    height = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
    step = max(1, round(src_fps / SAMPLE_FPS))
    cascade = cv2.CascadeClassifier(
        cv2.data.haarcascades + "haarcascade_frontalface_default.xml"
    )

    samples, tracks, prev_gray, prev_boxes = [], {}, None, {}
    idx = -1
    while True:
        ok, frame = cap.read()
        if not ok:
            break
        idx += 1
        if idx % step != 0:
            continue
        t = idx / src_fps
        gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
        small = cv2.resize(gray, (480, round(480 * gray.shape[0] / gray.shape[1])))
        sx = gray.shape[1] / small.shape[1]
        found = cascade.detectMultiScale(
            small, scaleFactor=1.1, minNeighbors=5, minSize=(48, 48)
        )
        curr = sorted(
            [(x * sx / gray.shape[1], y * sx / gray.shape[0],
              w * sx / gray.shape[1], h * sx / gray.shape[0])
             for x, y, w, h in found],
            key=lambda b: b[2] * b[3], reverse=True,
        )[:MAX_FACES]
        ids = match_tracks(
            [(i, tr["cx"], tr["cy"]) for i, tr in tracks.items()], curr
        )
        boxes = []
        seen = set()
        for tid, (cx, cy, w, h) in zip(ids, curr):
            motion = 0.0
            if tid in prev_boxes and prev_gray is not None:
                x0, y0, w0, h0 = prev_boxes[tid]
                mx, my = int((x0 + w0 * 0.1) * gray.shape[1]), int((y0 + h0 * 0.55) * gray.shape[0])
                mw, mh = int(w0 * 0.8 * gray.shape[1]), int(h0 * 0.4 * gray.shape[0])
                roi_now = gray[my : my + mh, mx : mx + mw]
                roi_prev = prev_gray[my : my + mh, mx : mx + mw]
                if roi_now.size > 0 and roi_now.shape == roi_prev.shape:
                    motion = float(
                        cv2.mean(cv2.absdiff(roi_now, roi_prev))[0]) / 255
            tracks[tid] = {"cx": cx + w / 2, "cy": cy + h / 2, "w": w, "h": h,
                           "miss": 0}
            seen.add(tid)
            boxes.append({"track": tid, "x": round(cx, 4), "y": round(cy, 4),
                          "w": round(w, 4), "h": round(h, 4),
                          "m": round(motion, 4)})
        for tid in list(tracks):
            if tid not in seen:
                tracks[tid]["miss"] += 1
                if tracks[tid]["miss"] > TRACK_TTL:
                    del tracks[tid]
        prev_gray = gray
        prev_boxes = {b["track"]: (b["x"], b["y"], b["w"], b["h"]) for b in boxes}
        samples.append({"t": round(t, 3), "boxes": boxes})
    cap.release()

    # Smooth each track's center/size series in place.
    by_track = {}
    for s in samples:
        for b in s["boxes"]:
            by_track.setdefault(b["track"], []).append(b)
    for series in by_track.values():
        for key in ("x", "y", "w", "h"):
            sm = smooth_series([b[key] for b in series])
            for b, v in zip(series, sm):
                b[key] = round(v, 4)

    scores = {}
    for s in samples:
        active = {sp for a, b, sp in segments if a <= s["t"] < b}
        for box in s["boxes"]:
            for sp in active:
                scores.setdefault(sp, {}).setdefault(box["track"], 0.0)
                scores[sp][box["track"]] += box["m"]
    face_map = map_speakers(scores)
    overlaps = find_overlaps(segments)

    with open(args.out, "w", encoding="utf-8") as f:
        json.dump({"width": width, "height": height, "sampleFps": SAMPLE_FPS,
                   "faces": samples, "faceMap": face_map, "overlaps": overlaps},
                  f)
    print(f"Wrote {args.out}: {len(samples)} samples, "
          f"{len(by_track)} face tracks, map={face_map}, "
          f"{len(overlaps)} overlaps")


if __name__ == "__main__":
    if "--selftest" in sys.argv:
        selftest()
        sys.exit(0)
    p = argparse.ArgumentParser()
    p.add_argument("--video", required=True)
    p.add_argument("--transcript", required=True)
    p.add_argument("--start", type=float, required=True)
    p.add_argument("--end", type=float, required=True)
    p.add_argument("--offset", type=float, required=True)
    p.add_argument("--out", required=True)
    main(p.parse_args())
