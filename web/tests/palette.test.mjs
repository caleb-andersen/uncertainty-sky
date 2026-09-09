import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  RAMP_CODES, RAMP_ENTRIES, blackbodySrgb, buildColourRamp, rampGradient,
  temperatureForBpRp,
} from '../src/palette.ts';

const DOMAIN = [-0.5, 5.5];
const entry = (ramp, code) => [...ramp.subarray(code * 4, code * 4 + 3)];

test('temperature falls monotonically as BP-RP reddens, and pins to its anchors', () => {
  let previous = Infinity;
  for (let step = 0; step <= 600; step++) {
    const kelvin = temperatureForBpRp(-0.5 + step / 100);
    assert.ok(kelvin < previous, `not decreasing at BP-RP ${-0.5 + step / 100}`);
    previous = kelvin;
  }
  // Solar BP-RP and A0V, the two anchors the middle of the ramp hangs on.
  assert.equal(Math.round(temperatureForBpRp(0.82)), 5772);
  assert.equal(Math.round(temperatureForBpRp(0)), 9500);
  // Outside the tabulated range the ends hold rather than extrapolating.
  assert.equal(temperatureForBpRp(-9), temperatureForBpRp(-0.5));
  assert.equal(temperatureForBpRp(99), temperatureForBpRp(5.5));
});

test('the locus runs orange to blue-white and never turns green', () => {
  const warm = blackbodySrgb(3_000);
  const hot = blackbodySrgb(20_000);
  assert.ok(warm[0] > warm[2], 'a 3000 K blackbody should be red-dominant');
  assert.ok(hot[2] > hot[0], 'a 20000 K blackbody should be blue-dominant');
  for (let kelvin = 1_500; kelvin <= 40_000; kelvin += 250) {
    const [r, g, b] = blackbodySrgb(kelvin);
    assert.ok(g <= Math.max(r, b), `green dominates at ${kelvin} K`);
  }
});

test('code 0 holds the unmeasured slot and never a temperature', () => {
  const unmeasured = [152, 152, 152];
  const ramp = buildColourRamp({ domain: DOMAIN, chroma: 1, unmeasured });
  assert.equal(ramp.length, RAMP_ENTRIES * 4);
  assert.deepEqual(entry(ramp, 0), unmeasured);
  // Codes 1..255 are the measured range: bluest at 1, reddest at 255.
  const bluest = entry(ramp, 1);
  const reddest = entry(ramp, RAMP_CODES);
  assert.ok(bluest[2] > bluest[0]);
  assert.ok(reddest[0] > reddest[2]);
});

test('chroma 0 leaves a luminance ramp, not a grey wash of the same value', () => {
  const ramp = buildColourRamp({ domain: DOMAIN, chroma: 0, unmeasured: [152, 152, 152] });
  for (let code = 1; code < RAMP_ENTRIES; code++) {
    const [r, g, b] = entry(ramp, code);
    assert.ok(Math.max(r, g, b) - Math.min(r, g, b) <= 1, `code ${code} kept chroma`);
  }
  assert.notDeepEqual(entry(ramp, 1), entry(ramp, RAMP_CODES));
});

test('the legend gradient is built from the ramp the GPU was handed', () => {
  const ramp = buildColourRamp({ domain: DOMAIN, chroma: 1, unmeasured: [152, 152, 152] });
  const gradient = rampGradient(ramp, 4);
  const [r, g, b] = entry(ramp, 1);
  assert.ok(gradient.startsWith(`linear-gradient(to right, rgb(${r} ${g} ${b}) 0%`));
  assert.equal(gradient.match(/rgb\(/g).length, 4);
});
