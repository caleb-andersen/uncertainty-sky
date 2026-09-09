import { CatmullRomCurve3, MathUtils, Vector3 } from 'three';

export const FLIGHT_SECONDS = 78;
export const RECORD_FPS = 60;
export const RECORD_PIXEL_RATIO = 2;

// Chapter boundaries double as edit points; every sample is a pure function
// of film time, so replaying or recording never depends on the previous take.
export const FLIGHT_CHAPTERS = [
  { start: 0, end: 10, label: 'Local field' },
  { start: 10, end: 36, label: 'Distance decades' },
  { start: 36, end: 42, label: 'Points and bounds · 2,000 pc' },
  { start: 42, end: 54, label: 'Across the sheaf' },
  { start: 54, end: 64, label: 'Outward' },
  { start: 64, end: 70, label: 'Plate to Confidence' },
  { start: 70, end: 74.6, label: 'Points and bounds · 15,000 pc' },
  { start: 74.6, end: FLIGHT_SECONDS, label: 'Measured bounds' },
] as const;

/** Seconds a subtitle takes to fade in, and to fade out before it clears. */
export const SUBTITLE_FADE = 0.35;

/**
 * Subtitles, timed to the shots. Each line says only what the frame is showing
 * at that moment: nothing is claimed for the sky that the renderer is not
 * drawing from the catalogue. Cues never overlap and leave a gap for the fade.
 */
export const FLIGHT_SUBTITLES = [
  { start: 1, end: 5, text: 'One parsec from Earth. The nearest stars.' },
  { start: 5.5, end: 9.5, text: 'Each streak is one star’s distance uncertainty.' },
  { start: 12, end: 16, text: 'Leaving the solar neighbourhood.' },
  { start: 21, end: 25.5, text: 'Farther out, distances are known less well.' },
  { start: 28.5, end: 33.5, text: 'Distant stars stretch into spears.' },
  { start: 36.5, end: 38.6, text: 'Drawn as points: an ordinary star map.' },
  { start: 39, end: 42, text: 'Drawn as measured: a range of possible distances.' },
  { start: 43.5, end: 48, text: 'Every streak points back at Earth.' },
  { start: 49, end: 53.5, text: 'Uncertainty lies along the line of sight.' },
  { start: 55.5, end: 60, text: 'Outward, to fifteen thousand parsecs.' },
  { start: 65, end: 69.5, text: 'Longer streaks now drawn fainter. The well-measured stars remain.' },
  { start: 70.6, end: 73.5, text: 'Every star map looks like this.' },
  { start: 73.9, end: 77.4, text: 'This is how well each distance is known.' },
] as const;

const smooth = (x: number) => x * x * (3 - 2 * x);
const beat = (seconds: number, start: number, end: number) =>
  smooth(MathUtils.clamp((seconds - start) / (end - start), 0, 1));

/**
 * The subtitle on screen at a film time, with its fade; empty between cues.
 *
 * Opacity is a function of film time rather than a CSS transition: a recording
 * that cannot hold the frame rate advances film time more slowly than the wall
 * clock, and a transition would drift out of step with the cut it belongs to.
 */
export function flightSubtitleAt(seconds: number): { text: string; opacity: number } {
  const cue = FLIGHT_SUBTITLES.find((c) => seconds >= c.start && seconds < c.end);
  if (!cue) return { text: '', opacity: 0 };
  const opacity = beat(seconds, cue.start, cue.start + SUBTITLE_FADE)
    * (1 - beat(seconds, cue.end - SUBTITLE_FADE, cue.end));
  return { text: cue.text, opacity };
}

/** Points are held for `hold` seconds at each comparison; the closing one lingers. */
export const POINTS_HOLD = { 36: 1, 70: 1.6 } as const;

export function flightMorph(seconds: number): number {
  // Each comparison: 1.5s collapse, the hold as points, 1.5s re-expansion.
  const start = seconds < 70 ? 36 : 70;
  const hold = POINTS_HOLD[start];
  return 1 - beat(seconds, start, start + 1.5)
    + beat(seconds, start + 1.5 + hold, start + 3 + hold);
}

export function flightTreatmentMix(seconds: number): number {
  return beat(seconds, 64, 70);
}

/** The closing approach turns across the field, then returns to Earth. */
export function flightLookOffset(seconds: number): number {
  return MathUtils.degToRad(25) * beat(seconds, 54, 60) * (1 - beat(seconds, 64, 70));
}

/** Integral of a smooth velocity ramp: constant log speed except at shot ends. */
function travel(seconds: number, duration: number): number {
  const t = MathUtils.clamp(seconds, 0, duration);
  const ramp = 2;
  const edge = (s: number) => {
    const x = s / ramp;
    return ramp * (x ** 3 - x ** 4 / 2);
  };
  if (t < ramp) return edge(t);
  if (t > duration - ramp) return duration - ramp - edge(duration - t);
  return t - ramp / 2;
}

/** Invert radius on an outward Catmull–Rom spline, retaining its actual shape. */
function radialPath(points: Vector3[]) {
  const curve = new CatmullRomCurve3(points, false, 'centripetal');
  const divisions = 8_192;
  const radii = new Float64Array(divisions + 1);
  const sample = new Vector3();
  for (let i = 0; i <= divisions; i++) {
    radii[i] = curve.getPoint(i / divisions, sample).length();
    if (i && radii[i] <= radii[i - 1]) throw new Error('Flight path must move outward');
  }
  return (radius: number, target: Vector3) => {
    if (radius <= radii[0]) return target.copy(points[0]);
    if (radius >= radii[divisions]) return target.copy(points[points.length - 1]);
    let low = 0;
    let high = divisions;
    while (high - low > 1) {
      const mid = (low + high) >>> 1;
      if (radii[mid] < radius) low = mid;
      else high = mid;
    }
    const fraction = (radius - radii[low]) / (radii[high] - radii[low]);
    return curve.getPoint((low + fraction) / divisions, target);
  };
}

/** Camera choreography only. No catalogue positions or errors are modified. */
export function createFlightPath() {
  const near = new CatmullRomCurve3([
    new Vector3(-0.4, -1, 0.04), new Vector3(0, -1, 0), new Vector3(0.4, -1, 0.08),
  ], false, 'centripetal');
  const localEnd = near.getPoint(1);
  const anchor = new Vector3(0, -1, 0.3).setLength(2_000);
  const outward = radialPath([
    localEnd, new Vector3(0.35, -1, 0.1).setLength(10),
    new Vector3(0.18, -1, 0.2).setLength(100),
    new Vector3(0.05, -1, 0.28).setLength(1_000), anchor,
  ]);
  const north = new Vector3(0, 0, 1);
  // Translating over 2,300 pc around Earth makes real parallax, not just yaw.
  const side = new CatmullRomCurve3([0, 25, 50, 75].map((angle) =>
    anchor.clone().applyAxisAngle(north, MathUtils.degToRad(angle))), false, 'centripetal');
  const sideEnd = side.getPoint(1);
  const end = sideEnd.clone().applyAxisAngle(north, MathUtils.degToRad(-10)).setLength(15_000);
  const far = radialPath([
    sideEnd, sideEnd.clone().setLength(5_000),
    sideEnd.clone().applyAxisAngle(north, MathUtils.degToRad(-5)).setLength(10_000), end,
  ]);
  const logRate = Math.log10(2_000 / localEnd.length()) / 24;
  const farDuration = Math.log10(15_000 / 2_000) / logRate + 2;
  return {
    positionAt(seconds: number, target: Vector3) {
      if (seconds < 10) return near.getPoint(beat(seconds, 0, 10), target);
      if (seconds < 36) return outward(
        localEnd.length() * 10 ** (logRate * travel(seconds - 10, 26)), target);
      if (seconds < 42) return target.copy(anchor);
      if (seconds < 54) return side.getPoint(beat(seconds, 42, 54), target);
      if (seconds < 54 + farDuration) return far(
        2_000 * 10 ** (logRate * travel(seconds - 54, farDuration)), target);
      return target.copy(end);
    },
    targetAt(seconds: number, target: Vector3) {
      // Earth stays within the frame but moves off-centre during the side pass.
      return target.set(500 * beat(seconds, 42, 46) * (1 - beat(seconds, 50, 54)), 0, 0);
    },
  };
}

/** Frame-indexed recording clock; delayed callbacks never skip film frames. */
export class FlightClock {
  private recording: boolean;
  private previous: number | null = null;
  private nextDue = 0;
  private frame = 0;
  private elapsed = 0;

  constructor(recording: boolean) {
    this.recording = recording;
  }

  pause() {
    this.previous = null;
    this.nextDue = 0;
  }

  /** Null means keep the previous canvas frame until the next recording slot. */
  sample(now: number): number | null {
    if (this.recording) {
      if (now + 0.5 < this.nextDue) return null;
      const interval = 1_000 / RECORD_FPS;
      // Preserve cadence under normal RAF jitter. After a stall, rebase the
      // deadline instead of rendering a burst or jumping ahead in the film.
      this.nextDue = this.nextDue && now - this.nextDue < interval
        ? this.nextDue + interval : now + interval;
      return Math.min(this.frame++ / RECORD_FPS, FLIGHT_SECONDS);
    }
    if (this.previous !== null) this.elapsed += Math.max(0, now - this.previous) / 1_000;
    this.previous = now;
    return Math.min(this.elapsed, FLIGHT_SECONDS);
  }
}
