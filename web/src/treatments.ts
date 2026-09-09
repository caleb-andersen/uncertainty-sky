/**
 * Three ways of drawing the same measurements.
 *
 * Nothing here changes geometry or decoding: every treatment draws the exact
 * near/far endpoints the packer wrote, with the same colour ramp basis, the
 * same stipple for unmeasured colour and the same dissolve on far endpoints
 * that are not measurements. What differs is emphasis - which stars carry the
 * visual weight, and how hard a long uncertainty is allowed to fade.
 *
 * The one parameter worth reading twice is `spread`. A star's light is drawn
 * smeared along its uncertainty, so a longer streak is a fainter one: at
 * `spread` 1 the total light of a streak is held constant no matter how long
 * it gets, at 0 every streak is drawn at full intensity per pixel and dense
 * fields blow out. Everything between is a display choice, disclosed on screen.
 */

export interface Treatment {
  id: string;
  label: string;
  /** One line shown under the selector, and in the README. */
  note: string;
  /** Page and canvas ground. */
  ground: string;
  /** 0 collapses the blackbody ramp to luminance, 1 keeps its full chroma. */
  chroma: number;
  /** sRGB bytes drawn for stars with no BP-RP measurement. */
  unmeasured: readonly [number, number, number];
  /** Overall intensity multiplier. */
  gain: number;
  /** Scales the view-relative distance falloff; higher reaches further out. */
  fadeScale: number;
  /** 0..1, how much of the smeared-light normalisation to apply. */
  spread: number;
  /** Length in pixels of a fully collapsed star, and the smear reference. */
  mark: number;
  /** Intensity floor and response exponent for the G magnitude channel. */
  magFloor: number;
  magGamma: number;
  /** Intensity for stars with no G magnitude measurement. */
  magUnknown: number;
  /**
   * Where along the streak the far-end dissolve starts, for flag 1 (clamped at
   * the horizon) and flag 2 (lower parallax <= 0, formally infinite). Flag 2
   * starts earlier because its far endpoint is the more arbitrary of the two.
   */
  tail: readonly [number, number];
  /** Stipple period in pixels and the fraction of each period drawn. */
  dashPeriod: number;
  dashDuty: number;
}

export const TREATMENTS: readonly Treatment[] = [
  {
    id: 'plate',
    label: 'Plate',
    note: 'Warm black, full stellar colour, light conserved as it smears. ' +
      'Well-measured stars stay sharp; uncertain ones ghost.',
    ground: '#0a0908',
    chroma: 1,
    unmeasured: [152, 152, 152],
    gain: 12,
    fadeScale: 1,
    spread: 0.55,
    mark: 1.6,
    magFloor: 0.3,
    magGamma: 1.5,
    magUnknown: 0.22,
    tail: [0.62, 0.28],
    dashPeriod: 6,
    dashDuty: 0.5,
  },
  {
    id: 'graphite',
    label: 'Graphite',
    note: 'Cool charcoal, colour pulled almost to monochrome, little smear ' +
      'normalisation. Geometry carries everything; the whole web stays legible.',
    ground: '#0d1012',
    chroma: 0.2,
    unmeasured: [172, 178, 184],
    gain: 1.25,
    fadeScale: 1.35,
    spread: 0.3,
    mark: 1.3,
    magFloor: 0.55,
    magGamma: 0.9,
    magUnknown: 0.45,
    tail: [0.7, 0.35],
    dashPeriod: 5,
    dashDuty: 0.45,
  },
  {
    id: 'confidence',
    label: 'Confidence',
    note: 'Neutral black, steep magnitude response, light fully conserved as ' +
      'it smears. Uncertainty dissolves as it stretches; a few hundred ' +
      'well-measured stars carry the frame.',
    ground: '#0b0b0c',
    chroma: 0.9,
    unmeasured: [140, 140, 144],
    gain: 2_200,
    fadeScale: 0.9,
    spread: 1,
    mark: 1.8,
    magFloor: 0,
    magGamma: 4,
    magUnknown: 0.01,
    tail: [0.5, 0.18],
    dashPeriod: 7,
    dashDuty: 0.5,
  },
];

export const DEFAULT_TREATMENT = TREATMENTS[0];
