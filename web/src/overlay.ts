/**
 * The film's overlay: the distance counter and the subtitles.
 *
 * The counter is handed the camera's radius in parsecs and formats it itself,
 * in both units, so its two lines can never disagree about where the camera is.
 *
 * Drawn with Canvas 2D rather than as page elements, because the video export
 * composites the same routine over the same rendered frame. What you watch in
 * the browser and what lands in the file come from one implementation, so they
 * cannot drift apart.
 *
 * Every size is a fraction of the frame height, taken against a 720-high
 * reference. A 1080p export and a 720p window are then proportionally
 * identical, and neither is tied to the page's own font sizes.
 *
 * The film's timing lives in src/flight.ts; this module is handed the cue for
 * the moment and only decides where it sits.
 */

const REFERENCE_HEIGHT = 720;
const FAMILY = 'system-ui, "Segoe UI", Roboto, Helvetica, Arial, sans-serif';
const INK = '#f2eee8';
const LABEL_INK = '#b8b2a9';
const DISTANCE_LABEL = 'DISTANCE FROM EARTH';

/**
 * Exact by definition: a parsec is 648000/pi astronomical units and a light
 * year is 9460730472580800 metres, so this ratio is a conversion and not a
 * measurement. Nothing about a star's own distance or its error is changed by
 * it; only the unit the counter is read in.
 */
export const LIGHT_YEARS_PER_PARSEC = 3.2615637771674333;

const NEAR = new Intl.NumberFormat('en', {
  minimumFractionDigits: 2, maximumFractionDigits: 2,
});
const MID = new Intl.NumberFormat('en', { maximumFractionDigits: 1 });
const FAR = new Intl.NumberFormat('en', { maximumFractionDigits: 0 });

/**
 * Digits drop as the number grows: two decimals while the camera is still
 * among the nearest stars, one out to a thousand, none beyond, where a
 * trailing digit on a five-figure count would only churn. Both units use the
 * same rule, so the two lines change character at the same points.
 */
const count = (value: number) => (value < 10 ? NEAR : value < 1_000 ? MID : FAR).format(value);

/**
 * The film's counter, as its two lines: the catalogue's own parsecs, and the
 * same distance in light years.
 *
 * Both are shown because neither alone serves the whole audience. Parsecs are
 * the unit the catalogue is in; light years are what a viewer who has never
 * met a parsec can picture, and what the subtitles already say. Units are
 * spelled out rather than abbreviated, because "pc" tells a first-time viewer
 * nothing and the frame has room for the word.
 */
export function distanceLines(parsecs: number): [string, string] {
  return [
    `${count(parsecs)} parsecs`,
    `${count(parsecs * LIGHT_YEARS_PER_PARSEC)} light years`,
  ];
}

/** Reference sizes, in pixels at a 720-high frame. */
const REFERENCE = {
  top: 28, right: 32, labelSize: 12, labelTracking: 2, labelGap: 6,
  valueSize: 24, secondValueSize: 18, valueGap: 8,
  // The wrap width grows with the type so a cue that used to sit on one line
  // still does: the longest cue measures 897px on a 1280 x 720 frame. Set just
  // above the 0.72 safe width so that rule governs at 16:9 and this one only
  // bites on wider frames. A machine whose fallback font runs wider wraps that
  // cue to two balanced lines instead, which is a fair result, not a break.
  subtitleSize: 32, subtitleLineHeight: 1.35, subtitleWidth: 940,
} as const;

/** One run of text, positioned in frame pixels. */
export interface OverlayItem {
  text: string;
  font: string;
  x: number;
  y: number;
  align: CanvasTextAlign;
  baseline: CanvasTextBaseline;
  color: string;
  opacity: number;
  /** CSS length for `ctx.letterSpacing`; a length, never an em, so it scales. */
  letterSpacing: string;
}

export type MeasureText = (text: string, font: string) => number;

/** A subtitle at one film time: `flightSubtitleAt` returns exactly this. */
export interface Cue {
  text: string;
  opacity: number;
}

/**
 * Break a line in two at its most even point, so a wrapped subtitle does not
 * leave one word stranded. Falls back to greedy wrapping when two lines will
 * not hold the text.
 */
function balancedWrap(
  text: string, font: string, maxWidth: number, measure: MeasureText,
): string[] {
  if (measure(text, font) <= maxWidth) return [text];
  const words = text.split(' ');
  let best: { lines: string[]; spread: number } | null = null;
  for (let split = 1; split < words.length; split++) {
    const head = words.slice(0, split).join(' ');
    const tail = words.slice(split).join(' ');
    const headWidth = measure(head, font);
    const tailWidth = measure(tail, font);
    if (headWidth > maxWidth || tailWidth > maxWidth) continue;
    const spread = Math.abs(headWidth - tailWidth);
    if (!best || spread < best.spread) best = { lines: [head, tail], spread };
  }
  if (best) return best.lines;
  const lines: string[] = [];
  let line = '';
  for (const word of words) {
    const candidate = line ? `${line} ${word}` : word;
    if (line && measure(candidate, font) > maxWidth) {
      lines.push(line);
      line = word;
    } else line = candidate;
  }
  if (line) lines.push(line);
  return lines;
}

/**
 * Everything on screen at one film time, as positioned runs of text. Pure, so
 * the layout can be checked without a canvas.
 */
export function overlayItems(
  width: number, height: number, cue: Cue, parsecs: number, measure: MeasureText,
): OverlayItem[] {
  const px = (reference: number) => reference * height / REFERENCE_HEIGHT;
  const right = width - px(REFERENCE.right);
  const [inParsecs, inLightYears] = distanceLines(parsecs);
  // One label over two readings of the same camera radius. Both runs are
  // right-aligned on the label's edge, so the block stays flush as digits come
  // and go, and the second is smaller: the same fact restated, not a second
  // measurement.
  const valueTop = REFERENCE.top + REFERENCE.labelSize + REFERENCE.labelGap;
  const items: OverlayItem[] = [
    {
      text: DISTANCE_LABEL,
      font: `500 ${px(REFERENCE.labelSize)}px ${FAMILY}`,
      x: right, y: px(REFERENCE.top), align: 'right', baseline: 'top',
      color: LABEL_INK, opacity: 1, letterSpacing: `${px(REFERENCE.labelTracking)}px`,
    },
    {
      text: inParsecs,
      font: `300 ${px(REFERENCE.valueSize)}px ${FAMILY}`,
      x: right, y: px(valueTop),
      align: 'right', baseline: 'top', color: INK, opacity: 1, letterSpacing: '0px',
    },
    {
      text: inLightYears,
      font: `300 ${px(REFERENCE.secondValueSize)}px ${FAMILY}`,
      x: right, y: px(valueTop + REFERENCE.valueSize + REFERENCE.valueGap),
      align: 'right', baseline: 'top', color: INK, opacity: 1, letterSpacing: '0px',
    },
  ];
  if (cue.text && cue.opacity > 0) {
    const size = px(REFERENCE.subtitleSize);
    const font = `400 ${size}px ${FAMILY}`;
    const lines = balancedWrap(
      cue.text, font, Math.min(width * 0.72, px(REFERENCE.subtitleWidth)), measure);
    const lineHeight = size * REFERENCE.subtitleLineHeight;
    // The block grows upward from a fixed baseline, so the last line never
    // moves when a cue wraps to two.
    const lastBaseline = height * 0.92;
    lines.forEach((line, index) => items.push({
      text: line, font, x: width / 2,
      y: lastBaseline - (lines.length - 1 - index) * lineHeight,
      align: 'center', baseline: 'alphabetic', color: INK,
      opacity: cue.opacity, letterSpacing: '0px',
    }));
  }
  return items;
}

/** Stacked shadows: a wide halo, a close one, then a tight drop. */
const SHADOWS = [[20, 0, 0.8], [8, 0, 1], [3, 1, 1]] as const;

/**
 * Paint one film frame's overlay over whatever the context already holds.
 *
 * This never clears. The export draws the rendered sky into the frame and then
 * calls this, so a clear here would wipe the picture and leave the text on
 * black. Clearing belongs to whoever owns the surface, which in live playback
 * is the transparent canvas sitting over the sky.
 *
 * The context is expected to be in frame pixels; live playback sets a
 * device-pixel-ratio transform first, and the export draws at the video's own
 * resolution.
 *
 * `dip` blacks the whole frame out, counter and subtitle included, to cover
 * the one cut in the film. It is painted last for that reason: during the dip
 * there is nothing on screen at all, so the change of position behind it is
 * never visible.
 */
export function drawOverlay(
  ctx: CanvasRenderingContext2D,
  width: number, height: number, cue: Cue, parsecs: number, dip = 0,
) {
  ctx.save();
  ctx.globalAlpha = 1;
  const measure: MeasureText = (text, font) => {
    ctx.font = font;
    ctx.letterSpacing = '0px';
    return ctx.measureText(text).width;
  };
  const scale = height / REFERENCE_HEIGHT;
  for (const item of overlayItems(width, height, cue, parsecs, measure)) {
    ctx.font = item.font;
    ctx.letterSpacing = item.letterSpacing;
    ctx.textAlign = item.align;
    ctx.textBaseline = item.baseline;
    ctx.fillStyle = item.color;
    ctx.globalAlpha = item.opacity;
    for (const [blur, offset, alpha] of SHADOWS) {
      ctx.shadowColor = `rgba(0, 0, 0, ${alpha})`;
      ctx.shadowBlur = blur * scale;
      ctx.shadowOffsetY = offset * scale;
      ctx.fillText(item.text, item.x, item.y);
    }
    ctx.shadowColor = 'transparent';
    ctx.shadowBlur = 0;
    ctx.shadowOffsetY = 0;
    ctx.fillText(item.text, item.x, item.y);
  }
  if (dip > 0) {
    ctx.globalAlpha = Math.min(dip, 1);
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, width, height);
  }
  ctx.restore();
}
