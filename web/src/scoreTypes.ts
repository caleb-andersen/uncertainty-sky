/**
 * The shape of a film score.
 *
 * A score is every authored decision about one particular flight: where the
 * camera goes, when it cuts, and what the cards say. `src/flight.ts` holds the
 * machinery that plays a score and knows none of these numbers. The split is
 * deliberate — the machinery is MIT, the score is not. See NOTICE.
 *
 * Nothing here touches the catalogue. A score moves the camera and writes the
 * captions; it cannot change a parallax, an error bar, or a drawn segment.
 */

/** A direction in the renderer's right-handed parsec space. Earth is origin. */
export type Vec = readonly [number, number, number];

/** A half-open window in seconds, `start` inclusive and `end` exclusive. */
export interface Span {
  readonly start: number;
  readonly end: number;
}

/** A line of narration, held for its span and faded at both ends. */
export interface Cue extends Span {
  readonly text: string;
}

/** A chapter boundary, which doubles as an edit point. */
export interface Shot extends Span {
  readonly label: string;
}

/** A direction flown at a fixed radius. */
export interface Waypoint {
  readonly at: Vec;
  readonly radius: number;
}

/**
 * A waypoint on the closing leg, given as a turn in degrees off the heading the
 * side pass exits on. Relative because the closing leg has to leave from
 * wherever the side pass ended, whatever angles that pass was written with.
 */
export interface Turn {
  readonly turn: number;
  readonly radius: number;
}

/**
 * A collapse to points, a hold, and a re-expansion, all without moving. The
 * camera is stationary throughout, so the only thing that changes is the
 * notation: the same stars, drawn first as dots and then as their bounds.
 */
export interface Comparison {
  readonly start: number;
  readonly hold: number;
}

export interface FlightScore {
  /**
   * The still opening, on its own clock starting at film time 0. Everything
   * else in the score is written in flight time and shifted by `seconds` once,
   * so lengthening the prologue never moves a later cut point.
   */
  readonly prologue: {
    readonly seconds: number;
    /** The prologue's one move: points expand into bounds, in place. */
    readonly expand: Span;
    /** Degrees of drift about the polar axis, settling onto the anchor. */
    readonly driftDegrees: number;
    readonly cues: readonly Cue[];
  };

  /** The dip to black covering the cut from the prologue into the flight. */
  readonly dip: {
    readonly fade: number;
    readonly hold: number;
  };

  /** Length of the flight after the prologue. */
  readonly duration: number;

  readonly shots: readonly Shot[];
  readonly cues: readonly Cue[];

  /** Seconds a card takes to fade in, and to fade out before it clears. */
  readonly subtitleFade: number;

  /** The points-and-bounds comparisons, and how long either transition runs. */
  readonly comparisons: {
    readonly collapse: number;
    readonly at: readonly Comparison[];
  };

  /** When the palette crosses from the plate treatment to the confidence one. */
  readonly treatment: Span;

  /** The closing turn across the field, and its return to Earth. */
  readonly look: {
    readonly degrees: number;
    readonly turn: Span;
    readonly settle: Span;
  };

  /** How far Earth slides off centre during the side pass, and back. */
  readonly aim: {
    readonly parsecs: number;
    readonly out: Span;
    readonly back: Span;
  };

  /**
   * Where each leg ends, in flight time. Every one of these must fall on a
   * shot boundary; the machinery checks that when it loads the score.
   */
  readonly cuts: {
    readonly near: number;
    readonly climb: number;
    readonly hold: number;
    readonly side: number;
  };

  readonly path: {
    /** The axis the prologue drift and both arcs turn about. */
    readonly polar: Vec;
    /** The drifting opener through the local field, flown as a spline. */
    readonly near: readonly Vec[];
    /** The radius the climb settles on, and the side pass holds. */
    readonly anchor: Waypoint;
    /** Intermediate waypoints on the climb out to the anchor. */
    readonly climb: readonly Waypoint[];
    /** Degrees about the polar axis, swept at the anchor's radius. */
    readonly side: readonly number[];
    /** The closing climb. Its last entry is the film's final position. */
    readonly far: readonly Turn[];
  };
}
