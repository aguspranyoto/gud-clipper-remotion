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
import { loadFont as loadDisplay } from "@remotion/google-fonts/SpaceGrotesk";
import { theme } from "./theme";

const display = loadDisplay("normal", { weights: ["700"] });

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
  mode: "single" | "split";
  /** Face track id, -1 = static center crop. */
  face: number;
};

export type FaceBox = { track: number; x: number; y: number; w: number; h: number };
export type FaceSample = { t: number; boxes: FaceBox[] };

export type BrollItem = {
  from: number;
  durationInFrames: number;
  file: string;
  kind: "image" | "video";
};

export type ClipProps = {
  fps: number;
  width: number;
  height: number;
  durationInFrames: number;
  /** Path relative to public/, e.g. "clips/clip-1.mp4". Audio comes with it. */
  clip: string;
  title: string;
  hook?: string;
  /** Static-crop fallback when no face data (face detect unavailable). */
  focus: "left" | "center" | "right";
  srcWidth: number;
  srcHeight: number;
  shots: Shot[];
  faces?: { sampleFps: number; samples: FaceSample[] };
  splitFaces?: [number, number];
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

const zoomFor = (w: number) =>
  Math.min(2.2, Math.max(1.3, 0.55 / Math.max(0.08, w)));

const Footage: React.FC<{ props: ClipProps }> = ({ props }) => {
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

  if (shot && shot.mode === "split" && props.splitFaces && (props.faces?.samples?.length ?? 0) > 0) {
    const [fa, fb] = props.splitFaces;
    const ba = faceAt(props.faces?.samples, fa, t) ?? { ...FALLBACK_BOX, x: 0.3 };
    const bb = faceAt(props.faces?.samples, fb, t) ?? { ...FALLBACK_BOX, x: 0.62 };
    const half = props.height / 2;
    return (
      <div style={{ transform: `scale(${1 + pop})`, width: "100%", height: "100%" }}>
        <CroppedVideo clip={props.clip} srcWidth={props.srcWidth}
          srcHeight={props.srcHeight} cx={ba.x + ba.w / 2} cy={ba.y + ba.h / 2}
          zoom={zoomFor(ba.w)} w={props.width} h={half} />
        <div style={{ height: 6, backgroundColor: "#000" }} />
        <CroppedVideo clip={props.clip} srcWidth={props.srcWidth}
          srcHeight={props.srcHeight} cx={bb.x + bb.w / 2} cy={bb.y + bb.h / 2}
          zoom={zoomFor(bb.w)} w={props.width} h={half - 6} />
      </div>
    );
  }

  const track = shot ? shot.face : -1;
  const samples = props.faces?.samples;
  let cx = 0.5;
  let cy = 0.5;
  let zoom = 1.1;
  const b =
    samples && samples.length > 0 ? faceAt(samples, track, t) : null;
  if (b) {
    cx = b.x + b.w / 2;
    cy = b.y + b.h / 2;
    zoom = track < 0 ? 1 : zoomFor(b.w);
  } else {
    // No face data: static crop, honoring the manual focus hint.
    cx = { left: 0.28, center: 0.5, right: 0.72 }[props.focus] ?? 0.5;
  }
  return (
    <div style={{ transform: `scale(${1 + pop})`, width: "100%", height: "100%" }}>
      <CroppedVideo clip={props.clip} srcWidth={props.srcWidth}
        srcHeight={props.srcHeight} cx={cx} cy={cy}
        zoom={zoom} w={props.width} h={props.height} />
    </div>
  );
};

const BrollView: React.FC<{ item: BrollItem }> = ({ item }) => {
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
    <AbsoluteFill style={{ opacity: exit, overflow: "hidden" }}>
      {media}
    </AbsoluteFill>
  );
};

/** Hook title: giant claim card over the first ~1.2s, then gone. */
const HookTitle: React.FC<{ text: string }> = ({ text }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const enter = spring({ frame, fps, config: theme.spring.snappy });
  const out = Math.round(fps * 1.2);
  const exit = interpolate(frame, [out - 8, out - 1], [0, -60], {
    easing: theme.ease.in,
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
  const exitOpacity = interpolate(frame, [out - 8, out - 1], [1, 0], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
  return (
    <AbsoluteFill
      style={{
        justifyContent: "flex-start",
        alignItems: "center",
        paddingTop: 300,
        opacity: enter * exitOpacity,
        transform: `translateY(${interpolate(enter, [0, 1], [50, 0]) + exit}px) scale(${interpolate(enter, [0, 1], [0.92, 1])})`,
      }}
    >
      <div
        style={{
          fontFamily: display.fontFamily,
          fontWeight: 700,
          fontSize: text.length > 26 ? 58 : 76,
          lineHeight: 1.05,
          letterSpacing: "-0.02em",
          textTransform: "uppercase",
          textAlign: "center",
          color: theme.colors.captionActive,
          backgroundColor: "rgba(0,0,0,0.72)",
          padding: "20px 36px",
          borderRadius: 18,
          maxWidth: "86%",
        }}
      >
        {text}
      </div>
    </AbsoluteFill>
  );
};

/**
 * Hormozi-style word captions: active word pops yellow, hot keywords stay
 * cyan, spoken words white, upcoming words dimmed. Real word timestamps.
 */
const CaptionCardView: React.FC<{ card: CaptionCard }> = ({ card }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const t = frame / fps;

  const enter = spring({ frame, fps, config: theme.spring.smooth });
  const exit = interpolate(
    frame,
    [card.durationInFrames - 8, card.durationInFrames - 1],
    [0, -36],
    { easing: theme.ease.in, extrapolateLeft: "clamp", extrapolateRight: "clamp" },
  );
  const exitOpacity = interpolate(
    frame,
    [card.durationInFrames - 8, card.durationInFrames - 1],
    [1, 0],
    { extrapolateLeft: "clamp", extrapolateRight: "clamp" },
  );

  const fontSize = 84;

  return (
    <AbsoluteFill
      style={{
        justifyContent: "flex-end",
        alignItems: "center",
        paddingBottom: 480, // block center lands ~67% height: inside the safe zone
        opacity: enter * exitOpacity,
        transform: `translateY(${interpolate(enter, [0, 1], [30, 0]) + exit}px)`,
      }}
    >
      <div
        style={{
          display: "flex",
          flexWrap: "wrap",
          justifyContent: "center",
          alignItems: "center",
          // px, not em: em gap resolves against the parent's 16px font.
          gap: Math.round(fontSize * 0.24),
          width: "100%",
          padding: "0 7%",
          boxSizing: "border-box",
          textAlign: "center",
        }}
      >
        {card.words.map((word, i) => {
          const active = t >= word.start && t < word.end;
          const spoken = t >= word.end;
          const pop = spring({
            frame: frame - Math.round(word.start * fps),
            fps,
            config: theme.spring.snappy,
          });
          const color = active
            ? theme.colors.captionActive
            : word.hot
              ? theme.colors.accent
              : theme.colors.text;
          return (
            <span
              key={`${word.text}-${i}`}
              style={{
                display: "inline-block",
                fontFamily: display.fontFamily,
                fontWeight: 700,
                fontSize: word.hot && !active ? fontSize * 1.08 : fontSize,
                lineHeight: 1.14,
                letterSpacing: "-0.01em",
                textTransform: "uppercase",
                color,
                opacity: spoken || active || word.hot ? 1 : 0.45,
                transform: active
                  ? `scale(${interpolate(pop, [0, 1], [0.8, 1.12])})`
                  : "scale(1)",
                textShadow:
                  "0 4px 0 rgba(0,0,0,0.9), 0 10px 36px rgba(0,0,0,0.65)",
              }}
            >
              {word.text}
            </span>
          );
        })}
      </div>
    </AbsoluteFill>
  );
};

const ProgressBar: React.FC<{ total: number }> = ({ total }) => {
  const frame = useCurrentFrame();
  return (
    <AbsoluteFill style={{ justifyContent: "flex-end" }}>
      <div style={{ height: 10, backgroundColor: "rgba(255,255,255,0.25)" }}>
        <div
          style={{
            height: "100%",
            width: `${Math.min(100, (frame / Math.max(1, total)) * 100)}%`,
            backgroundColor: theme.colors.accent,
          }}
        />
      </div>
    </AbsoluteFill>
  );
};

const Grade: React.FC = () => (
  <AbsoluteFill style={{ pointerEvents: "none" }}>
    <AbsoluteFill
      style={{
        backgroundColor: theme.colors.primary,
        mixBlendMode: "soft-light",
        opacity: 0.18,
      }}
    />
    <AbsoluteFill
      style={{
        background:
          "linear-gradient(180deg, rgba(0,0,0,0.16), transparent 28%, transparent 62%, rgba(0,0,0,0.32))",
      }}
    />
  </AbsoluteFill>
);

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

export const ClipVideo: React.FC<ClipProps> = (props) => {
  const hookFrames = Math.round(props.fps * 1.2);
  return (
    <AbsoluteFill style={{ backgroundColor: theme.colors.bg }}>
      <Footage props={props} />
      {(props.broll ?? []).map((item, i) => (
        <Sequence key={`b-${i}`} from={item.from} durationInFrames={item.durationInFrames}>
          <BrollView item={item} />
        </Sequence>
      ))}
      {props.captions.map((card, i) => (
        <Sequence key={i} from={card.from} durationInFrames={card.durationInFrames}>
          <CaptionCardView card={card} />
        </Sequence>
      ))}
      {props.hook ? (
        <Sequence from={0} durationInFrames={Math.min(hookFrames, props.durationInFrames)}>
          <HookTitle text={props.hook} />
        </Sequence>
      ) : null}
      <ProgressBar total={props.durationInFrames} />
      <Grade />
      <Grain />
      <Vignette />
    </AbsoluteFill>
  );
};
