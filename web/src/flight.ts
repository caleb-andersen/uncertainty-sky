/**
 * The projector: everything needed to play a film score, and none of the score.
 *
 * `src/score.ts` holds the authored flight - waypoints, cut points, cards. This
 * module holds only the machinery that reads one: the easing, the spline
 * inversion that gives each distance decade equal time, the subtitle fader, and
 * the frame-indexed recording clock. Swap the score and this file is unchanged.
 *
 * The split is licensing as much as structure. The machinery is MIT; a score is
 * not. See NOTICE.
 *
 * Nothing here modifies catalogue positions or errors. A flight moves the
 * camera and nothing else.
 */
import { CatmullRomCurve3, MathUtils, Vector3 } from 'three';
import { SCORE } from './score.ts';
import type { FlightScore, Vec, Waypoint } from './scoreTypes.ts';

/** Delivery format, not authorship: these stay with the projector. */
export const RECORD_FPS = 60;
export const RECORD_PIXEL_RATIO = 2;

/** Seconds of smooth acceleration at either end of an outward leg. */
const RAMP = 2;

/**
 * A score is checked once, on load, and rejected loudly rather than played
 * wrong. A leg that does not end on a cut would put a camera discontinuity
 * inside a shot, where no dip is covering it.
 */
function verify(score: FlightScore): FlightScore {
  const { shots, duration, cuts } = score;
  if (!shots.length || shots[0].start !== 0 || shots.at(-1)!.end !== duration) {
    throw new Error('Score shots must cover the flight from 0 to its duration');
  }
  shots.slice(1).forEach((shot, i) => {
    if (shot.start !== shots[i].end) throw new Error(`Score has a gap at ${shot.start}s`);
  });
  const edges = new Set<number>(shots.map((shot) => shot.start));
  for (const [leg, at] of Object.entries(cuts)) {
    if (!edges.has(at)) throw new Error(`Score cut "${leg}" at ${at}s is not a shot boundary`);
  }
  return score;
}

const score = verify(SCORE);

export const PROLOGUE_SECONDS = score.prologue.seconds;
export const PROLOGUE_EXPAND = score.prologue.expand;
export const DIP = score.dip;
export const FLIGHT_DURATION = score.duration;
export const FLIGHT_SECONDS = PROLOGUE_SECONDS + FLIGHT_DURATION;
export const SUBTITLE_FADE = score.subtitleFade;

/**
 * Where each leg of the flight ends, in flight time. Exported so a test can
 * address a leg without knowing the score's numbers: the values come from the
 * score at run time and are not written down here.
 */
export const FLIGHT_CUTS = score.cuts;

/** Where each comparison starts, in flight time, and how long its points hold. */
export const POINTS_HOLD: Record<number, number> = Object.fromEntries(
  score.comparisons.at.map(({ start, hold }) => [start, hold]));

// Chapter boundaries double as edit points; every sample is a pure function of
// film time, so replaying or recording never depends on the previous take. The
// flight's are written in flight time and shifted once, here.
export const FLIGHT_CHAPTERS = [
  { start: 0, end: PROLOGUE_EXPAND.start, label: 'Prologue · points' },
  { start: PROLOGUE_EXPAND.start, end: PROLOGUE_SECONDS, label: 'Prologue · bounds' },
  ...score.shots.map(({ start, end, label }) => ({
    start: start + PROLOGUE_SECONDS, end: end + PROLOGUE_SECONDS, label,
  })),
];

export const FLIGHT_SUBTITLES = [
  ...score.prologue.cues.map(({ start, end, text }) => ({ start, end, text })),
  ...score.cues.map(({ start, end, text }) => ({
    start: start + PROLOGUE_SECONDS, end: end + PROLOGUE_SECONDS, text,
  })),
];

const smooth = (x: number) => x * x * (3 - 2 * x);
const beat = (seconds: number, start: number, end: number) =>
  smooth(MathUtils.clamp((seconds - start) / (end - start), 0, 1));
const span = (seconds: number, range: { start: number; end: number }) =>
  beat(seconds, range.start, range.end);
const vector = (xyz: Vec) => new Vector3(xyz[0], xyz[1], xyz[2]);
const placed = (point: Waypoint) => vector(point.at).setLength(point.radius);

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

export function flightMorph(seconds: number): number {
  // The prologue opens as points and expands once, reaching bounds before the
  // flight begins, which is where the flight's own first frame already sits.
  if (seconds < PROLOGUE_SECONDS) return span(seconds, PROLOGUE_EXPAND);
  const t = seconds - PROLOGUE_SECONDS;
  const { collapse, at } = score.comparisons;
  // Before the first comparison every term is clamped to its start, so the
  // bounds read whole; the same holds after the last one re-expands.
  const active = at.reduce((chosen, c) => (t >= c.start ? c : chosen), at[0]);
  return 1 - beat(t, active.start, active.start + collapse)
    + beat(t, active.start + collapse + active.hold,
      active.start + 2 * collapse + active.hold);
}

/**
 * How much black covers the frame, hiding the cut into the flight. Symmetric
 * about the join and zero everywhere else, so it is the only place in the film
 * where anything is drawn over the sky besides the counter and the subtitle.
 */
export function flightDip(seconds: number): number {
  return 1 - beat(Math.abs(seconds - PROLOGUE_SECONDS), DIP.hold, DIP.hold + DIP.fade);
}

// The remaining choreography is zero throughout the prologue, so subtracting
// the offset is enough: a negative flight time clamps every beat to its start.

export function flightTreatmentMix(seconds: number): number {
  return span(seconds - PROLOGUE_SECONDS, score.treatment);
}

/** The closing approach turns across the field, then returns to Earth. */
export function flightLookOffset(seconds: number): number {
  const t = seconds - PROLOGUE_SECONDS;
  const { degrees, turn, settle } = score.look;
  return MathUtils.degToRad(degrees) * span(t, turn) * (1 - span(t, settle));
}

/** Integral of a smooth velocity ramp: constant log speed except at leg ends. */
function travel(seconds: number, duration: number): number {
  const t = MathUtils.clamp(seconds, 0, duration);
  const edge = (s: number) => {
    const x = s / RAMP;
    return RAMP * (x ** 3 - x ** 4 / 2);
  };
  if (t < RAMP) return edge(t);
  if (t > duration - RAMP) return duration - RAMP - edge(duration - t);
  return t - RAMP / 2;
}

/** Invert radius on an outward Catmull-Rom spline, retaining its actual shape. */
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
  const { path, cuts, aim } = score;
  const finish = path.far[path.far.length - 1];
  const near = new CatmullRomCurve3(path.near.map(vector), false, 'centripetal');
  const localEnd = near.getPoint(1);
  const anchor = placed(path.anchor);
  const outward = radialPath([localEnd, ...path.climb.map(placed), anchor]);
  const polar = vector(path.polar);
  const side = new CatmullRomCurve3(path.side.map((angle) =>
    anchor.clone().applyAxisAngle(polar, MathUtils.degToRad(angle))), false, 'centripetal');
  const sideEnd = side.getPoint(1);
  const turned = (leg: { turn: number; radius: number }) => sideEnd.clone()
    .applyAxisAngle(polar, MathUtils.degToRad(leg.turn)).setLength(leg.radius);
  const far = radialPath([sideEnd, ...path.far.map(turned)]);
  const end = turned(finish);

  // Equal time per distance decade, set by the climb and reused by the closing
  // leg, so the film never changes how fast a decade goes by.
  const logRate = Math.log10(path.anchor.radius / localEnd.length())
    / (cuts.climb - cuts.near - RAMP);
  const farDuration = Math.log10(finish.radius / path.anchor.radius) / logRate + RAMP;

  // The prologue holds the anchor, drifting onto it. Its distance from the
  // flight's opening position is the whole reason for the dip.
  return {
    positionAt(seconds: number, target: Vector3) {
      if (seconds < PROLOGUE_SECONDS) {
        return target.copy(anchor).applyAxisAngle(polar,
          MathUtils.degToRad(score.prologue.driftDegrees)
            * (1 - beat(seconds, 0, PROLOGUE_SECONDS)));
      }
      const t = seconds - PROLOGUE_SECONDS;
      if (t < cuts.near) return near.getPoint(beat(t, 0, cuts.near), target);
      if (t < cuts.climb) return outward(localEnd.length()
        * 10 ** (logRate * travel(t - cuts.near, cuts.climb - cuts.near)), target);
      if (t < cuts.hold) return target.copy(anchor);
      if (t < cuts.side) return side.getPoint(beat(t, cuts.hold, cuts.side), target);
      if (t < cuts.side + farDuration) return far(path.anchor.radius
        * 10 ** (logRate * travel(t - cuts.side, farDuration)), target);
      return target.copy(end);
    },
    targetAt(seconds: number, target: Vector3) {
      // Earth stays within the frame but moves off-centre during the side pass.
      const t = seconds - PROLOGUE_SECONDS;
      return target.set(aim.parsecs * span(t, aim.out) * (1 - span(t, aim.back)), 0, 0);
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
