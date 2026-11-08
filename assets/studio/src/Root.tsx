import React from "react";
import { Composition } from "remotion";
import { ClipVideo, ClipProps } from "./ClipVideo";

const defaultProps: ClipProps = {
  fps: 30,
  width: 1080,
  height: 1920,
  durationInFrames: 150,
  clip: "clips/clip-1.mp4",
  title: "Placeholder — replaced by make-clip-props.mjs output",
  sourceLabel: "SUMBER : CHANNEL",
  focus: "center",
  srcWidth: 1920,
  srcHeight: 1080,
  shots: [{ from: 0, durationInFrames: 150, face: -1 }],
  punchTimes: [],
  captions: [
    {
      from: 0,
      durationInFrames: 150,
      words: [
        { text: "CONTOH", start: 0, end: 0.5 },
        { text: "TIGA", start: 0.5, end: 1, hot: true },
        { text: "KATA", start: 1, end: 1.5 },
      ],
    },
  ],
};

export const Root: React.FC = () => (
  <Composition
    id="Clip"
    component={ClipVideo}
    defaultProps={defaultProps}
    durationInFrames={defaultProps.durationInFrames}
    fps={defaultProps.fps}
    width={defaultProps.width}
    height={defaultProps.height}
    calculateMetadata={({ props }) => ({
      durationInFrames: props.durationInFrames,
      fps: props.fps,
      width: props.width,
      height: props.height,
    })}
  />
);
