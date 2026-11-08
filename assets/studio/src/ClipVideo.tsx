import React from "react";
import {
  AbsoluteFill,
  Img,
  OffthreadVideo,
  Sequence,
  interpolate,
  spring,
  staticFile,
  useCurrentFrame,
  useVideoConfig,
} from "remotion";
import { loadFont as loadAnton } from "@remotion/google-fonts/Anton";
import { theme } from "./theme";

const anton = loadAnton("normal", { weights: ["400"], subsets: ["latin"] });

export type CaptionWord = {
  text: string;
  /** Clip-local seconds. */
  start: number;
  end: number;
  hot?: boolean;
};

export type CaptionCard = {
  from: number;
  durationInFrames: number;
  words: CaptionWord[];
};

export type Shot = {
  from: number;
  durationInFrames: number;
  /** Face track id, -1 = static wide crop. Always a single wide shot. */
  face: number;
};

export type FaceBox = { track: number; x: number; y: number; w: number; h: number };
export type FaceSample = { t: number; boxes: FaceBox[] };

export type BrollItem = {
  from: number;
  durationInFrames: number;
  file: string;
  kind: "image" | "video";
  /** true = full-bleed over the whole frame; false = bottom-half panel. */
  full?: boolean;
};

export type ClipProps = {
  fps: number;
  width: number;
  height: number;
  durationInFrames: number;
  /** Path relative to public/, e.g. "clips/clip-1.mp4". Audio comes with it. */
  clip: string;
  title: string;
  /** e.g. "SUMBER : ROCKAROMAID" — persistent top-left label. */
  sourceLabel?: string;
  /** Static-crop fallback when no face data (face detect unavailable). */
  focus: "left" | "center" | "right";
  srcWidth: number;
  srcHeight: number;
  shots: Shot[];
  faces?: { sampleFps: number; samples: FaceSample[] };
  punchTimes?: number[];
  broll?: BrollItem[];
  captions: CaptionCard[];
};

const FALLBACK_BOX = { x: 0.38, y: 0.3, w: 0.24, h: 0.4 };

/** Lerp the tracked face center/size at clip-local time t. */
const faceAt = (
  samples: FaceSample[] | undefined,
  track: number,
  t: number,
) => {
  if (!samples || samples.length === 0 || track < 0) return null;
  let a = samples[0];
  let b = samples[samples.length - 1];
  for (const s of samples) {
    if (s.t <= t) a = s;
    if (s.t >= t) {
      b = s;
      break;
    }
  }
  const pick = (s: FaceSample) => (s.boxes || []).find((x) => x.track === track);
  const ba = pick(a);
  const bb = pick(b);
  if (!ba && !bb) return null;
  if (!bb || a === b) return ba ?? bb;
  if (!ba) return bb;
  const k = (t - a.t) / Math.max(1e-6, b.t - a.t);
  const lerp = (u: number, v: number) => u + (v - u) * k;
  return {
    x: lerp(ba.x, bb.x),
    y: lerp(ba.y, bb.y),
    w: lerp(ba.w, bb.w),
    h: lerp(ba.h, bb.h),
  };
};

/** Crop a window (center cx/cy, zoom) out of the landscape source. */
const CroppedVideo: React.FC<{
  clip: string;
  srcWidth: number;
  srcHeight: number;
  cx: number;
  cy: number;
  zoom: number;
  w: number;
  h: number;
}> = ({ clip, srcWidth, srcHeight, cx, cy, zoom, w, h }) => {
  const winH = srcHeight / zoom;
  const winW = winH * (w / h);
  const qx = Math.min(Math.max(cx * srcWidth, winW / 2), srcWidth - winW / 2);
  const qy = Math.min(Math.max(cy * srcHeight, winH / 2), srcHeight - winH / 2);
  const scale = h / winH;
  return (
    <div style={{ width: w, height: h, overflow: "hidden", position: "relative" }}>
      <OffthreadVideo
        src={staticFile(clip)}
        style={{
          position: "absolute",
          width: srcWidth * scale,
          height: srcHeight * scale,
          left: w / 2 - qx * scale,
          top: h / 2 - qy * scale,
        }}
      />
    </div>
  );
};

/**
 * Wide framing on purpose: zoom stays near 1.0–1.25 so the shot reads as a
 * medium-wide two-shot. The camera follows the speaker loosely (blended
 * toward frame center) instead of punching into their face.
 */
const zoomFor = (w: number) =>
  Math.min(1.25, Math.max(1.02, 0.28 / Math.max(0.08, w)));

const Footage: React.FC<{ props: ClipProps; topOnly: boolean }> = ({
  props,
  topOnly,
}) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const shot =
    props.shots.find(
      (s) => frame >= s.from && frame < s.from + s.durationInFrames,
    ) ?? props.shots[0];
  const t = frame / fps;

  // Zoom punch: quick 7% pop decaying over ~16 frames after each punchline.
  let pop = 0;
  for (const p of props.punchTimes ?? []) {
    const d = frame - Math.round(p * fps);
    if (d < 0 || d > 16) continue;
    pop = Math.max(
      pop,
      d <= 6
        ? interpolate(d, [0, 6], [0, 0.07], {
            easing: theme.ease.out,
            extrapolateLeft: "clamp",
            extrapolateRight: "clamp",
          })
        : interpolate(d, [6, 16], [0.07, 0], {
            easing: theme.ease.in,
            extrapolateLeft: "clamp",
            extrapolateRight: "clamp",
          }),
    );
  }

  const track = shot ? shot.face : -1;
  const samples = props.faces?.samples;
  let cx = 0.5;
  let cy = 0.5;
  let zoom = 1.05;
  const b =
    samples && samples.length > 0 ? faceAt(samples, track, t) : null;
  if (b) {
    // Follow the speaker but drift toward center so a co-host stays in
    // frame; bias slightly down to keep torso/gestures visible.
    cx = (b.x + b.w / 2) * 0.7 + 0.5 * 0.3;
    cy = b.y + b.h / 2 + 0.06;
    zoom = track < 0 ? 1.05 : zoomFor(b.w);
  } else {
    // No face data: static wide crop, honoring the manual focus hint.
    cx = { left: 0.35, center: 0.5, right: 0.65 }[props.focus] ?? 0.5;
  }
  const h = topOnly ? props.height / 2 : props.height;
  return (
    <div style={{ transform: `scale(${1 + pop})`, width: "100%", height: h }}>
      <CroppedVideo clip={props.clip} srcWidth={props.srcWidth}
        srcHeight={props.srcHeight} cx={cx} cy={cy}
        zoom={zoom} w={props.width} h={h} />
    </div>
  );
};

const BrollMedia: React.FC<{ item: BrollItem }> = ({ item }) => {
  const frame = useCurrentFrame();
  // Ken Burns: slow push-in over the cutaway.
  const z = interpolate(frame, [0, item.durationInFrames], [1, 1.08], {
    easing: theme.ease.inOut,
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
  const exit = interpolate(
    frame,
    [item.durationInFrames - 8, item.durationInFrames - 1],
    [1, 0],
    { extrapolateLeft: "clamp", extrapolateRight: "clamp" },
  );
  const media =
    item.kind === "image" ? (
      <Img
        src={staticFile(item.file)}
        style={{ width: "100%", height: "100%", objectFit: "cover", transform: `scale(${z})` }}
      />
    ) : (
      <OffthreadVideo
        src={staticFile(item.file)}
        volume={0}
        style={{ width: "100%", height: "100%", objectFit: "cover", transform: `scale(${z})` }}
      />
    );
  return (
    <div style={{ width: "100%", height: "100%", overflow: "hidden", opacity: exit }}>
      {media}
    </div>
  );
};

/** Persistent source credit, top-left: "SUMBER : CHANNEL". */
const SourceLabel: React.FC<{ text: string }> = ({ text }) => (
  <div
    style={{
      position: "absolute",
      top: 34,
      left: 40,
      fontFamily: anton.fontFamily,
      fontWeight: 400,
      fontSize: 46,
      letterSpacing: "0.01em",
      textTransform: "uppercase",
      color: "#FFFFFF",
      WebkitTextStroke: "1.5px #000",
      paintOrder: "stroke fill",
      textShadow: "0 3px 0 rgba(0,0,0,0.9), 0 8px 28px rgba(0,0,0,0.6)",
    }}
  >
    {text}
  </div>
);

/**
 * Reference-style caption: EXACTLY one line, ALL CAPS condensed bold,
 * white with black stroke, active/keyword word in yellow. No dimming,
 * no wrapping — cards are built 3-words-max upstream.
 */
const CaptionCardView: React.FC<{ card: CaptionCard; anchorY: number }> = ({
  card,
  anchorY,
}) => {
  const frame = useCurrentFrame();
  const { fps, height } = useVideoConfig();
  const t = frame / fps;

  const chars = card.words.map((w) => w.text).join(" ").length;
  const fontSize = chars <= 14 ? 88 : chars <= 20 ? 78 : 66;

  return (
    <div
      style={{
        position: "absolute",
        top: anchorY * height - fontSize * 0.6,
        width: "100%",
        padding: "0 5%",
        boxSizing: "border-box",
        textAlign: "center",
        whiteSpace: "nowrap",
      }}
    >
      {card.words.map((word, i) => {
        const active = t >= word.start && t < word.end;
        const pop = spring({
          frame: frame - Math.round(word.start * fps),
          fps,
          config: theme.spring.snappy,
        });
        const color =
          active || word.hot ? theme.colors.captionActive : "#FFFFFF";
        return (
          <span
            key={`${word.text}-${i}`}
            style={{
              display: "inline-block",
              fontFamily: anton.fontFamily,
              fontWeight: 400,
              fontSize,
              lineHeight: 1.14,
              letterSpacing: "0.01em",
              textTransform: "uppercase",
              color,
              marginRight: i < card.words.length - 1 ? Math.round(fontSize * 0.24) : 0,
              transform: active
                ? `scale(${interpolate(pop, [0, 1], [0.8, 1.12])})`
                : "scale(1)",
              WebkitTextStroke: "2px #000",
              paintOrder: "stroke fill",
              textShadow:
                "0 4px 0 rgba(0,0,0,0.9), 0 10px 36px rgba(0,0,0,0.65)",
            }}
          >
            {word.text}
          </span>
        );
      })}
    </div>
  );
};

const Grain: React.FC = () => {
  const frame = useCurrentFrame();
  const noise = `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='220' height='220'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.9' numOctaves='2'/%3E%3C/filter%3E%3Crect width='220' height='220' filter='url(%23n)' opacity='0.5'/%3E%3C/svg%3E")`;
  return (
    <AbsoluteFill
      style={{
        pointerEvents: "none",
        backgroundImage: noise,
        backgroundSize: "220px",
        backgroundPosition: `${(frame * 7) % 220}px ${(frame * 13) % 220}px`,
        opacity: 0.05,
        mixBlendMode: "multiply",
      }}
    />
  );
};

const Vignette: React.FC = () => (
  <AbsoluteFill
    style={{
      pointerEvents: "none",
      background:
        "radial-gradient(ellipse at center, transparent 56%, rgba(0,0,0,0.22) 100%)",
    }}
  />
);

const brollCovering = (broll: BrollItem[] | undefined, frame: number) =>
  (broll ?? []).find(
    (b) => frame >= b.from && frame < b.from + b.durationInFrames,
  );

export const ClipVideo: React.FC<ClipProps> = (props) => {
  const frame = useCurrentFrame();
  const activeBroll = brollCovering(props.broll, frame);
  const panelBroll = activeBroll && !activeBroll.full ? activeBroll : null;
  const fullBroll = activeBroll && activeBroll.full ? activeBroll : null;
  // Caption sits on the 50/50 seam when split, center-frame over full
  // b-roll, slightly above center over full-bleed speaker footage.
  const anchorY = panelBroll ? 0.5 : fullBroll ? 0.5 : 0.42;
  const topOnly = panelBroll !== null;
  return (
    <AbsoluteFill style={{ backgroundColor: theme.colors.bg }}>
      <Footage props={props} topOnly={topOnly} />
      {panelBroll ? (
        <div
          style={{
            position: "absolute",
            top: props.height / 2,
            width: props.width,
            height: props.height / 2,
          }}
        >
          <BrollMedia item={panelBroll} />
        </div>
      ) : null}
      {fullBroll ? (
        <AbsoluteFill>
          <BrollMedia item={fullBroll} />
        </AbsoluteFill>
      ) : null}
      {props.sourceLabel ? <SourceLabel text={props.sourceLabel} /> : null}
      {props.captions.map((card, i) => (
        <Sequence key={i} from={card.from} durationInFrames={card.durationInFrames}>
          <CaptionCardView card={card} anchorY={anchorY} />
        </Sequence>
      ))}
      <Grain />
      <Vignette />
    </AbsoluteFill>
  );
};
