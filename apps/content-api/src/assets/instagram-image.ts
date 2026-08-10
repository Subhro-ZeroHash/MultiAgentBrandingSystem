/**
 * Reshaping a creative into something the Instagram feed will accept.
 *
 * Meta enforces an aspect ratio between 4:5 and 1.91:1 and downscales anything
 * wider than 1440px. Most of our output formats already comply, but poster_a4
 * does not: 2480x3508 is 0.707, below the 4:5 floor, so Instagram rejects it
 * however the request is made.
 *
 * Padding rather than cropping is the deliberate choice. A poster is a
 * typographic layout with a headline near the top and a CTA near the bottom —
 * exactly the regions a centre crop to 4:5 would remove. Letterboxing keeps the
 * whole design intact and costs only the bars beside it.
 */

/** Meta's documented feed bounds. */
export const INSTAGRAM_MIN_RATIO = 4 / 5;
export const INSTAGRAM_MAX_RATIO = 1.91;
/** Wider than this and Instagram resamples anyway; doing it ourselves keeps the
 *  upload small and the result predictable. */
export const INSTAGRAM_MAX_WIDTH = 1440;

export interface InstagramCanvas {
  /** Final image dimensions handed to Instagram. */
  canvasWidth: number;
  canvasHeight: number;
  /** The creative, scaled to sit inside that canvas. Equal to the canvas when
   *  no padding is needed. */
  imageWidth: number;
  imageHeight: number;
  /** Whether the source had to be letterboxed to reach a legal ratio. */
  padded: boolean;
}

/** True when Instagram would reject or resample the image as-is. */
export function needsInstagramFit(width: number, height: number): boolean {
  const ratio = width / height;
  return ratio < INSTAGRAM_MIN_RATIO || ratio > INSTAGRAM_MAX_RATIO || width > INSTAGRAM_MAX_WIDTH;
}

/**
 * The canvas an image of these dimensions should be rendered onto.
 *
 * Clamps the ratio into Meta's range by growing the short axis — never by
 * cutting the long one — then scales the whole thing down to the width cap.
 */
export function instagramCanvas(width: number, height: number): InstagramCanvas {
  const ratio = width / height;

  // Grow one axis so the ratio lands exactly on the nearest bound. The image
  // itself keeps its own dimensions and is centred on the result.
  let canvasWidth = width;
  let canvasHeight = height;
  let padded = false;

  if (ratio < INSTAGRAM_MIN_RATIO) {
    canvasWidth = Math.round(height * INSTAGRAM_MIN_RATIO);
    padded = true;
  } else if (ratio > INSTAGRAM_MAX_RATIO) {
    canvasHeight = Math.round(width / INSTAGRAM_MAX_RATIO);
    padded = true;
  }

  // Scale canvas and image together so the image stays centred and the ratio
  // established above is preserved.
  const scale = canvasWidth > INSTAGRAM_MAX_WIDTH ? INSTAGRAM_MAX_WIDTH / canvasWidth : 1;

  return {
    canvasWidth: Math.round(canvasWidth * scale),
    canvasHeight: Math.round(canvasHeight * scale),
    imageWidth: Math.round(width * scale),
    imageHeight: Math.round(height * scale),
    padded,
  };
}
