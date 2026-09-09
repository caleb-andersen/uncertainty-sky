import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createStarMaterial } from '../src/starMaterial.ts';
import { TREATMENTS } from '../src/treatments.ts';

const plate = TREATMENTS.find((t) => t.id === 'plate');
const confidence = TREATMENTS.find((t) => t.id === 'confidence');
const make = () => createStarMaterial({ bpRpDomain: [-0.5, 5.5], treatment: plate });

test('treatment fade reuses one texture and cached endpoint ramps, including the sentinel', () => {
  const field = make();
  field.prepareTreatments([plate, confidence]);
  field.setTreatment(plate);
  const a = field.ramp;
  field.setTreatment(confidence);
  const b = field.ramp;
  const texture = field.material.uniforms.uRamp.value;
  field.setTreatmentBlend(plate, confidence, 0.5);
  const blend = field.ramp;
  for (let i = 0; i < blend.length; i++) assert.equal(blend[i], Math.round((a[i] + b[i]) / 2));
  assert.equal(field.material.uniforms.uRamp.value, texture);
  const version = texture.version;
  field.setTreatmentBlend(plate, confidence, 0.5);
  assert.equal(texture.version, version, 'a held treatment must not reupload its texture');
  field.setTreatmentBlend(plate, confidence, 0.6);
  assert.equal(field.ramp, blend, 'reuse the blending buffer');
  field.setTreatmentBlend(plate, confidence, 0);
  assert.equal(field.ramp, a, 'restore the cached Plate bytes');
  field.setTreatmentBlend(plate, confidence, 1);
  assert.equal(field.ramp, b, 'restore the cached Confidence bytes');
  field.dispose();
});

test('all numeric shader controls and distance falloff blend; exposure uses log space', () => {
  const field = make();
  const uniforms = field.material.uniforms;
  field.setTreatmentBlend(plate, confidence, 0.5);
  const mapping = { uMark: 'mark', uSpread: 'spread', uMagFloor: 'magFloor', uMagGamma: 'magGamma',
    uMagUnknown: 'magUnknown', uDashPeriod: 'dashPeriod', uDashDuty: 'dashDuty' };
  for (const [uniform, key] of Object.entries(mapping)) {
    assert.ok(Math.abs(uniforms[uniform].value - (plate[key] + confidence[key]) / 2) < 1e-10);
  }
  assert.ok(Math.abs(uniforms.uGain.value - Math.sqrt(plate.gain * confidence.gain)) < 1e-10);
  uniforms.uTail.value.toArray().forEach((value, i) =>
    assert.ok(Math.abs(value - (plate.tail[i] + confidence.tail[i]) / 2) < 1e-10));
  field.setViewDistance(2_000);
  assert.equal(uniforms.uFadeReference.value, 2_000 * (plate.fadeScale + confidence.fadeScale) / 2);
  field.setTreatment(confidence);
  assert.equal(uniforms.uGain.value, confidence.gain);
  field.setViewDistance(2_000);
  assert.equal(uniforms.uFadeReference.value, 2_000 * confidence.fadeScale);
  field.dispose();
});

test('supersampling passes physical viewport and pixel ratio without changing catalogue uniforms', () => {
  const field = make();
  field.setMorph(0.5);
  field.setViewport(2_560, 1_440, 0.001, 2);
  const uniforms = field.material.uniforms;
  assert.deepEqual(uniforms.uViewport.value.toArray(), [2_560, 1_440]);
  assert.equal(uniforms.uPixelRatio.value, 2);
  assert.equal(uniforms.uMark.value, plate.mark);
  assert.equal(uniforms.uMorph.value, 0.5);
  assert.equal(uniforms.uNear.value, 0.001);
  field.dispose();
});
