/**
 * Stellar colour: Gaia BP-RP -> effective temperature -> sRGB.
 *
 * Two lookups, both coarse, both display-only:
 *
 *   1. BP-RP -> Teff, piecewise linear through main-sequence anchor points.
 *      The real relation is not a function: giants and dwarfs of the same
 *      colour have different temperatures, metallicity shifts it, and BP-RP is
 *      an *observed* colour, so interstellar reddening makes a distant hot star
 *      read as a cool one. None of that is corrected here. The anchors are a
 *      legend for a colour ramp, not a temperature measurement, and the UI
 *      says as much.
 *
 *   2. Teff -> sRGB, piecewise linear on log T through a tabulated Planckian
 *      locus, each entry normalised so its largest channel is 255.
 *
 * The result is the blackbody run and nothing else: deep orange near 2000 K,
 * white around 6500 K, pale blue-white above 10000 K. A blackbody never passes
 * through green and never reaches a saturated blue, so this ramp cannot turn
 * into a rainbow no matter what the catalogue contains.
 */

type Rgb = readonly [number, number, number];

// (BP-RP, Teff) anchors, roughly main sequence. Solar BP-RP ~ 0.82 at 5772 K
// and A0V ~ 0.0 at 9500 K are the two that pin the middle of the ramp.
const TEMPERATURE_ANCHORS: readonly (readonly [number, number])[] = [
  [-0.50, 24_000], [-0.30, 15_000], [-0.10, 10_500], [0.00, 9_500],
  [0.20, 8_300], [0.40, 7_300], [0.60, 6_500], [0.82, 5_772],
  [1.00, 5_350], [1.40, 4_600], [1.80, 4_000], [2.20, 3_700],
  [2.80, 3_400], [3.50, 3_100], [4.50, 2_800], [5.50, 2_500],
];

// Planckian locus in sRGB, max channel normalised to 255. Chromaticity only:
// the intensity a star is drawn at comes from its G magnitude, not from here.
const BLACKBODY: readonly (readonly [number, Rgb])[] = [
  [2_000, [255, 137, 14]], [2_500, [255, 159, 70]], [3_000, [255, 180, 107]],
  [3_500, [255, 196, 137]], [4_000, [255, 209, 163]], [4_500, [255, 219, 186]],
  [5_000, [255, 228, 206]], [5_500, [255, 236, 224]], [6_000, [255, 243, 239]],
  [6_500, [255, 249, 253]], [7_000, [245, 243, 255]], [7_500, [235, 238, 255]],
  [8_000, [227, 233, 255]], [9_000, [214, 225, 255]], [10_000, [204, 219, 255]],
  [12_000, [191, 211, 255]], [15_000, [181, 205, 255]], [20_000, [172, 199, 255]],
  [25_000, [168, 197, 255]], [30_000, [165, 195, 255]],
];

/** Codes 1..255 carry a measurement; 0 is the packer's "not measured". */
export const RAMP_CODES = 255;
export const RAMP_ENTRIES = 256;

function interpolate(
  table: readonly (readonly [number, unknown])[], x: number,
): { lower: number; upper: number; t: number } {
  if (x <= table[0][0]) return { lower: 0, upper: 0, t: 0 };
  const last = table.length - 1;
  if (x >= table[last][0]) return { lower: last, upper: last, t: 0 };
  let upper = 1;
  while (table[upper][0] < x) upper++;
  const span = table[upper][0] - table[upper - 1][0];
  return { lower: upper - 1, upper, t: (x - table[upper - 1][0]) / span };
}

/** Approximate main-sequence effective temperature for an observed BP-RP. */
export function temperatureForBpRp(bpRp: number): number {
  const { lower, upper, t } = interpolate(TEMPERATURE_ANCHORS, bpRp);
  const a = TEMPERATURE_ANCHORS[lower][1];
  const b = TEMPERATURE_ANCHORS[upper][1];
  return a + (b - a) * t;
}

/** Planckian locus colour for a temperature, as sRGB bytes. */
export function blackbodySrgb(kelvin: number): Rgb {
  // Interpolate on log T: the table thins out above 10,000 K, where colour
  // changes slowly, and log spacing keeps the steps even.
  const logTable = BLACKBODY.map(([k, rgb]) => [Math.log(k), rgb] as const);
  const { lower, upper, t } = interpolate(logTable, Math.log(kelvin));
  const a = BLACKBODY[lower][1];
  const b = BLACKBODY[upper][1];
  return [
    a[0] + (b[0] - a[0]) * t,
    a[1] + (b[1] - a[1]) * t,
    a[2] + (b[2] - a[2]) * t,
  ];
}

const toLinear = (channel: number) => {
  const c = channel / 255;
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
};
const toSrgb = (linear: number) => {
  const c = linear <= 0.0031308 ? linear * 12.92 : 1.055 * linear ** (1 / 2.4) - 0.055;
  return Math.round(Math.min(1, Math.max(0, c)) * 255);
};

/** Pull a colour toward its own luminance. `chroma` of 1 leaves it untouched. */
function desaturate(rgb: Rgb, chroma: number): Rgb {
  if (chroma >= 1) return rgb;
  const [r, g, b] = [toLinear(rgb[0]), toLinear(rgb[1]), toLinear(rgb[2])];
  const luma = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  const mix = (channel: number) => toSrgb(luma + (channel - luma) * chroma);
  return [mix(r), mix(g), mix(b)];
}

export interface RampOptions {
  /** BP-RP values that codes 1 and 255 decode to, from the packer's manifest. */
  domain: readonly [number, number];
  /** 0 collapses the ramp to luminance, 1 keeps the full blackbody chroma. */
  chroma: number;
  /** sRGB bytes stored at code 0, the "no BP-RP measurement" slot. */
  unmeasured: Rgb;
}

/**
 * Build the 256-entry RGBA lookup the shader indexes with the raw colour code.
 * Entry 0 is the sentinel slot: it is never a temperature, and the shader
 * stipples anything that lands there so it cannot be read as a measured hue.
 */
export function buildColourRamp({ domain, chroma, unmeasured }: RampOptions): Uint8Array {
  const [low, high] = domain;
  const data = new Uint8Array(RAMP_ENTRIES * 4);
  const write = (index: number, [r, g, b]: Rgb) => {
    data.set([Math.round(r), Math.round(g), Math.round(b), 255], index * 4);
  };
  write(0, desaturate(unmeasured, 1));
  for (let code = 1; code < RAMP_ENTRIES; code++) {
    const bpRp = low + ((code - 1) / (RAMP_CODES - 1)) * (high - low);
    write(code, desaturate(blackbodySrgb(temperatureForBpRp(bpRp)), chroma));
  }
  return data;
}

/** The same ramp as a CSS gradient, so the on-screen legend cannot drift. */
export function rampGradient(ramp: Uint8Array, stops = 32): string {
  const colours = [];
  for (let stop = 0; stop < stops; stop++) {
    const code = 1 + Math.round((stop / (stops - 1)) * (RAMP_CODES - 1));
    const at = code * 4;
    colours.push(`rgb(${ramp[at]} ${ramp[at + 1]} ${ramp[at + 2]}) ${(stop / (stops - 1)) * 100}%`);
  }
  return `linear-gradient(to right, ${colours.join(', ')})`;
}
