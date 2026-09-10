/**
 * A worked example score, so the repo runs without the author's film.
 *
 * This is deliberately not the film published from this project. It is short,
 * plain, and exists to demonstrate the shape a score takes and to keep the
 * renderer exercisable. Copy it to `score.ts` and rewrite it; that file is
 * gitignored, so your own flight stays yours. See NOTICE section 3.
 *
 * `npm run dev`, `build`, `test` and `export` all copy this file into place
 * automatically when `score.ts` is missing.
 */
import type { FlightScore } from './scoreTypes.ts';

export const SCORE: FlightScore = {
  prologue: {
    seconds: 6,
    expand: { start: 3, end: 4.5 },
    driftDegrees: -4,
    cues: [
      { start: 0.8, end: 3, text: 'Each star is drawn as its measured distance range.' },
      { start: 3.5, end: 5.4, text: 'Short means certain. Long means uncertain.' },
    ],
  },

  dip: { fade: 0.35, hold: 0.15 },

  duration: 40,

  shots: [
    { start: 0, end: 6, label: 'Local field' },
    { start: 6, end: 22, label: 'Distance decades' },
    { start: 22, end: 26, label: 'Points and bounds · 1,000 pc' },
    { start: 26, end: 34, label: 'Across the sheaf' },
    { start: 34, end: 40, label: 'Outward' },
  ],

  cues: [
    { start: 1, end: 4, text: 'Example score. Replace it with your own.' },
    { start: 8, end: 12, text: 'Moving outward from the local field.' },
    { start: 23, end: 25.5, text: 'Points, then measured bounds.' },
    { start: 35, end: 38.5, text: 'Outward, with the uncertain stars fading.' },
  ],

  subtitleFade: 0.35,

  comparisons: { collapse: 1.5, at: [{ start: 22, hold: 1 }] },

  treatment: { start: 34, end: 38 },
  look: { degrees: 20, turn: { start: 34, end: 37 }, settle: { start: 37, end: 40 } },
  aim: { parsecs: 300, out: { start: 26, end: 29 }, back: { start: 31, end: 34 } },

  cuts: { near: 6, climb: 22, hold: 26, side: 34 },

  path: {
    polar: [0, 0, 1],
    near: [[0.3, 0.9, 0.1], [0, 1, 0], [-0.3, 0.9, -0.1]],
    anchor: { at: [0, 1, 0.25], radius: 1_000 },
    climb: [
      { at: [-0.2, 1, 0.1], radius: 20 },
      { at: [-0.1, 1, 0.2], radius: 200 },
    ],
    side: [0, 30, 60, 90],
    far: [{ turn: 0, radius: 3_000 }, { turn: -5, radius: 6_000 }],
  },
};
