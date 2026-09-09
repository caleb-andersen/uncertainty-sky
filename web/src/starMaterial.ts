import {
  AddEquation, ClampToEdgeWrapping, CustomBlending, DataTexture, NearestFilter,
  OneFactor, RGBAFormat, ShaderMaterial, UnsignedByteType, Vector2,
} from 'three';
import { RAMP_ENTRIES, buildColourRamp } from './palette';
import type { Treatment } from './treatments';

/**
 * The distance falloff is relative to where the camera is, not absolute: the
 * reference distance tracks the orbit radius, so flying outward through a
 * rising star count does not simply dim the whole catalogue. These bracket it
 * so the near field still reads at 1 pc and the far field at 20,000 pc.
 */
const FADE_REFERENCE_PC = { min: 300, max: 30_000 };

/**
 * Two vertices per star, near endpoint then far. Neither the endpoints nor
 * their order are stored per vertex, and neither needs to be: bounds.py puts
 * both on the same ray from Earth, so `midpoint` is the outward line of sight
 * and the sign of dot(position - midpoint, midpoint) says which end a vertex
 * is. That keeps the layout at the five buffers the packer already writes.
 *
 * `uMorph` slides each vertex between the midpoint and its true bound. It is a
 * straight lerp, so at every setting the drawn segment is a centred
 * sub-interval of the measured one - never an extrapolation, never a smoothed
 * shape.
 *
 * Three display decisions live here, none of them in the data:
 *
 *   - A collapsed star is drawn `uMark` pixels long rather than zero, because
 *     a zero-length line does not rasterise. That is the floor any point mark
 *     would hit anyway.
 *   - A star's light is smeared along its uncertainty, so a longer streak is
 *     drawn fainter (see `uSpread`). Total light is what a longer exposure
 *     conserves; per-pixel intensity is not.
 *   - Brightness falls off with distance from the camera so density does not
 *     blow out. It is applied per star, from the midpoint, so it is constant
 *     along a streak: fading *along* a streak is reserved for one thing only,
 *     a far endpoint that is not a measurement.
 */
const vertexShader = /* glsl */ `
uniform float uMorph;
uniform vec2 uViewport;
uniform float uNear;
uniform float uMark;
uniform float uFadeReference;
uniform float uSpread;
uniform float uGain;
uniform float uMagFloor;
uniform float uMagGamma;
uniform float uMagUnknown;
uniform float uDashPeriod;
uniform sampler2D uRamp;

attribute vec3 midpoint;
attribute float bpRpCode;
attribute float magCode;
attribute float farFlag;

varying vec3 vTint;
varying float vWeight;
varying float vSpan;
varying float vFlag;
varying float vDashPhase;
varying float vDashMix;

// Symmetric perspective only, which is what PerspectiveCamera builds. Depth is
// clamped at the near plane so a streak straddling the camera still yields a
// finite screen length instead of a division blow-up.
vec2 toScreen(vec3 viewPosition) {
  float depth = max(-viewPosition.z, uNear);
  return vec2(projectionMatrix[0][0] * viewPosition.x,
              projectionMatrix[1][1] * viewPosition.y) / depth * uViewport * 0.5;
}

void main() {
  vec3 lineOfSight = normalize(midpoint);
  vec3 axis = position - midpoint;
  float side = dot(axis, lineOfSight) < 0.0 ? -1.0 : 1.0;
  vSpan = side * 0.5 + 0.5;
  vFlag = farFlag;

  vec4 midView = modelViewMatrix * vec4(midpoint, 1.0);
  vec3 axisView = normalize(mat3(modelViewMatrix) * lineOfSight);
  float halfLength = length(axis) * uMorph;

  float pixelsPerParsec =
    0.5 * uViewport.y * projectionMatrix[1][1] / max(-midView.z, uNear);
  halfLength = max(halfLength, 0.5 * uMark / max(pixelsPerParsec, 1e-8));

  vec3 nearEnd = midView.xyz - axisView * halfLength;
  vec3 farEnd = midView.xyz + axisView * halfLength;
  gl_Position = projectionMatrix * vec4(side < 0.0 ? nearEnd : farEnd, 1.0);

  float mark = max(distance(toScreen(nearEnd), toScreen(farEnd)), uMark);
  float ratio = length(midView.xyz) / uFadeReference;
  float attenuation = 1.0 / (1.0 + ratio * ratio);

  // Code 0 is the packer's "no G magnitude for this star" and gets its own
  // fixed intensity rather than a plausible-looking one.
  float magnitude = clamp((magCode - 1.0) / 254.0, 0.0, 1.0);
  float weight = magCode < 0.5
    ? uMagUnknown
    : mix(uMagFloor, 1.0, pow(magnitude, uMagGamma));

  vWeight = uGain * attenuation * weight * pow(uMark / mark, uSpread);
  vTint = texture2D(uRamp, vec2((bpRpCode + 0.5) / ${RAMP_ENTRIES}.0, 0.5)).rgb;

  // Stars with no BP-RP are stippled. A negative mix means "draw solid"; for
  // the rest it fades the pattern out once the mark is too short to resolve,
  // so an unmeasured star dims but never vanishes.
  float periods = mark / uDashPeriod;
  vDashPhase = vSpan * periods;
  vDashMix = bpRpCode < 0.5 ? smoothstep(1.5, 3.5, periods) : -1.0;
}
`;

/**
 * Colour arrives already resolved from the ramp, so the fragment stage only
 * decides how much of a streak survives: the dissolve on far endpoints that
 * were clamped rather than measured, and the stipple on stars with no colour.
 */
const fragmentShader = /* glsl */ `
uniform vec2 uTail;
uniform float uDashDuty;

varying vec3 vTint;
varying float vWeight;
varying float vSpan;
varying float vFlag;
varying float vDashPhase;
varying float vDashMix;

void main() {
  float alpha = vWeight;

  // Flag 1 was clamped at the horizon; flag 2 had a non-positive lower
  // parallax and is formally infinite. Neither far endpoint is a measurement,
  // so neither is allowed to end on a hard edge.
  if (vFlag > 0.5) {
    float start = vFlag > 1.5 ? uTail.y : uTail.x;
    alpha *= 1.0 - smoothstep(start, 1.0, vSpan);
  }

  if (vDashMix >= 0.0) {
    float lit = 1.0 - smoothstep(uDashDuty - 0.12, uDashDuty + 0.12, fract(vDashPhase));
    alpha *= mix(uDashDuty, lit, vDashMix);
  }

  if (alpha < 0.0015) discard;
  gl_FragColor = vec4(vTint * alpha, 1.0);
}
`;

export interface StarMaterialOptions {
  /** BP-RP values codes 1 and 255 decode to, from the packer's manifest. */
  bpRpDomain: readonly [number, number];
  treatment: Treatment;
}

export function createStarMaterial({ bpRpDomain, treatment }: StarMaterialOptions) {
  let bytes = buildColourRamp({
    domain: bpRpDomain, chroma: treatment.chroma, unmeasured: treatment.unmeasured,
  });
  const ramp = new DataTexture(bytes, RAMP_ENTRIES, 1, RGBAFormat, UnsignedByteType);
  // Nearest sampling, clamped wrap: a code must resolve to its own entry and
  // never to a blend with its neighbour or with the sentinel slot.
  ramp.magFilter = ramp.minFilter = NearestFilter;
  ramp.wrapS = ramp.wrapT = ClampToEdgeWrapping;
  ramp.generateMipmaps = false;
  ramp.needsUpdate = true;

  const material = new ShaderMaterial({
    vertexShader,
    fragmentShader,
    uniforms: {
      uMorph: { value: 1 },
      uViewport: { value: new Vector2(1, 1) },
      uNear: { value: 0.01 },
      uFadeReference: { value: FADE_REFERENCE_PC.min },
      uRamp: { value: ramp },
      uMark: { value: treatment.mark },
      uSpread: { value: treatment.spread },
      uGain: { value: treatment.gain },
      uMagFloor: { value: treatment.magFloor },
      uMagGamma: { value: treatment.magGamma },
      uMagUnknown: { value: treatment.magUnknown },
      uDashPeriod: { value: treatment.dashPeriod },
      uDashDuty: { value: treatment.dashDuty },
      uTail: { value: new Vector2(treatment.tail[0], treatment.tail[1]) },
    },
    transparent: true,
    // One unordered additive layer. Depth would only let stars occlude each
    // other, which is the opposite of what accumulating faint light needs.
    depthTest: false,
    depthWrite: false,
    blending: CustomBlending,
    blendEquation: AddEquation,
    blendSrc: OneFactor,
    blendDst: OneFactor,
    blendSrcAlpha: OneFactor,
    blendDstAlpha: OneFactor,
  });

  const uniforms = material.uniforms;
  return {
    material,
    /** Live ramp bytes, so the on-screen legend samples what the GPU has. */
    get ramp() { return bytes; },
    setTreatment(next: Treatment) {
      bytes = buildColourRamp({
        domain: bpRpDomain, chroma: next.chroma, unmeasured: next.unmeasured,
      });
      ramp.image.data = bytes;
      ramp.needsUpdate = true;
      uniforms.uMark.value = next.mark;
      uniforms.uSpread.value = next.spread;
      uniforms.uGain.value = next.gain;
      uniforms.uMagFloor.value = next.magFloor;
      uniforms.uMagGamma.value = next.magGamma;
      uniforms.uMagUnknown.value = next.magUnknown;
      uniforms.uDashPeriod.value = next.dashPeriod;
      uniforms.uDashDuty.value = next.dashDuty;
      (uniforms.uTail.value as Vector2).set(next.tail[0], next.tail[1]);
    },
    setMorph(morph: number) {
      uniforms.uMorph.value = morph;
    },
    setViewport(width: number, height: number, near: number) {
      (uniforms.uViewport.value as Vector2).set(width, height);
      uniforms.uNear.value = near;
    },
    /** Track the orbit radius so the falloff stays relative to the view. */
    setViewDistance(parsecs: number, current: Treatment) {
      const { min, max } = FADE_REFERENCE_PC;
      uniforms.uFadeReference.value =
        Math.min(max, Math.max(min, parsecs)) * current.fadeScale;
    },
    dispose() {
      material.dispose();
      ramp.dispose();
    },
  };
}
