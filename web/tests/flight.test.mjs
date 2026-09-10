/**
 * The invariants every score must satisfy, whichever film is loaded.
 *
 * Nothing here names a waypoint, a cut time or a line of narration. Those live
 * in the score, and the score's own assertions live beside it in
 * tests/score.test.mjs, which is not committed. This file has to pass against
 * src/score.example.ts as readily as against the author's film, so each test
 * reads the shape it needs from the projector's exports.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Vector3 } from 'three';
import {
  createFlightPath, DIP, FlightClock, flightDip, flightLookOffset, flightMorph,
  flightSubtitleAt, flightTreatmentMix, FLIGHT_CHAPTERS, FLIGHT_CUTS, FLIGHT_DURATION,
  FLIGHT_SECONDS, FLIGHT_SUBTITLES, POINTS_HOLD, PROLOGUE_EXPAND, PROLOGUE_SECONDS,
  RECORD_FPS, RECORD_PIXEL_RATIO, SUBTITLE_FADE,
} from '../src/flight.ts';

const path = createFlightPath();
const filmAt = (seconds) => path.positionAt(seconds, new Vector3());
const close = (a, b, epsilon = 1e-7) => assert.ok(Math.abs(a - b) < epsilon, `${a} != ${b}`);

// The flight keeps its own clock, so every assertion below is written in flight
// time. `film` is the only place the prologue offset appears.
const film = (seconds) => seconds + PROLOGUE_SECONDS;
const at = (seconds) => filmAt(film(seconds));
const morph = (seconds) => flightMorph(film(seconds));
const look = (seconds) => flightLookOffset(film(seconds));
const targetAt = (seconds) => path.targetAt(film(seconds), new Vector3());

/** Every film frame, in flight time, as the recorder would step through them. */
const frames = function* () {
  for (let frame = 0; frame <= FLIGHT_SECONDS * RECORD_FPS; frame++) {
    yield frame / RECORD_FPS - PROLOGUE_SECONDS;
  }
};

test('the projector takes its whole shape from the score it was handed', () => {
  assert.ok(PROLOGUE_SECONDS > 0 && FLIGHT_DURATION > 0);
  assert.equal(FLIGHT_SECONDS, PROLOGUE_SECONDS + FLIGHT_DURATION);
  assert.ok(PROLOGUE_EXPAND.start < PROLOGUE_EXPAND.end);
  assert.ok(PROLOGUE_EXPAND.end <= PROLOGUE_SECONDS, 'bounds are whole before the flight');
  assert.ok(Object.keys(POINTS_HOLD).length >= 1, 'at least one comparison');
  // Legs run in order and each ends on a chapter boundary, which is what lets
  // the camera change direction without a cut showing inside a shot.
  const { near, climb, hold, side } = FLIGHT_CUTS;
  assert.ok(0 < near && near < climb && climb < hold && hold < side && side < FLIGHT_DURATION);
  const edges = new Set(FLIGHT_CHAPTERS.map((chapter) => chapter.start - PROLOGUE_SECONDS));
  for (const cut of [near, climb, hold, side]) assert.ok(edges.has(cut), `cut at ${cut}s`);
});

test('chapters are contiguous and cover the film exactly once', () => {
  assert.equal(FLIGHT_CHAPTERS[0].start, 0);
  assert.equal(FLIGHT_CHAPTERS.at(-1).end, FLIGHT_SECONDS);
  FLIGHT_CHAPTERS.slice(1).forEach((chapter, i) =>
    assert.equal(chapter.start, FLIGHT_CHAPTERS[i].end));
  FLIGHT_CHAPTERS.forEach((chapter) => {
    assert.ok(chapter.end > chapter.start, chapter.label);
    assert.ok(chapter.label.length > 0);
  });
});

test('the prologue holds one radius and expands points into bounds in place', () => {
  const radius = filmAt(0).length();
  for (let t = 0; t <= PROLOGUE_SECONDS; t += 0.1) close(filmAt(t).length(), radius, 1e-9);
  assert.ok(filmAt(0).distanceTo(filmAt(PROLOGUE_SECONDS - 1e-9)) > 0, 'the prologue drifts');
  assert.equal(flightMorph(0), 0);
  assert.equal(flightMorph(PROLOGUE_EXPAND.start), 0);
  assert.equal(flightMorph(PROLOGUE_EXPAND.end), 1);
  assert.equal(flightMorph(PROLOGUE_SECONDS), 1);
  // Nothing but the expansion happens before the flight starts.
  for (let t = 0; t <= PROLOGUE_SECONDS; t += 1 / 60) {
    assert.ok(flightMorph(t) >= 0 && flightMorph(t) <= 1);
    assert.equal(flightLookOffset(t), 0);
    assert.equal(flightTreatmentMix(t), 0);
    assert.equal(path.targetAt(t, new Vector3()).length(), 0);
  }
});

test('a dip to black covers the cut, and nothing else in the film fades', () => {
  assert.ok(DIP.fade > 0 && DIP.hold > 0);
  assert.equal(flightDip(PROLOGUE_SECONDS), 1);
  for (const offset of [-DIP.hold, DIP.hold]) {
    assert.equal(flightDip(PROLOGUE_SECONDS + offset), 1);
  }
  for (const offset of [-(DIP.hold + DIP.fade), DIP.hold + DIP.fade]) {
    assert.equal(flightDip(PROLOGUE_SECONDS + offset), 0);
  }
  close(flightDip(PROLOGUE_SECONDS - DIP.hold - DIP.fade / 2), 0.5);
  close(flightDip(PROLOGUE_SECONDS + DIP.hold + DIP.fade / 2), 0.5);
  // Black nowhere else, and no subtitle is on screen while it is up.
  const span = DIP.hold + DIP.fade;
  for (const t of frames()) {
    const dip = flightDip(film(t));
    assert.ok(dip >= 0 && dip <= 1);
    if (Math.abs(t) >= span) assert.equal(dip, 0, `${t}s`);
    if (dip > 0) assert.equal(flightSubtitleAt(film(t)).opacity, 0, `${t}s`);
  }
});

test('the camera never moves while the notation is changing under it', () => {
  // A comparison is the one place the drawing changes rather than the view, so
  // wherever the bounds are not whole the frame must be still. This is what
  // keeps the collapse readable as a change of notation, not of position.
  let held = 0;
  let stationary = null;
  for (const t of frames()) {
    if (t < 0) continue;
    const value = morph(t);
    assert.ok(value >= 0 && value <= 1, `${t}s`);
    if (value === 1) {
      stationary = null;
      continue;
    }
    if (value === 0) held++;
    stationary ??= at(t);
    assert.deepEqual(at(t), stationary, `camera moved mid-comparison at ${t}s`);
    assert.equal(look(t), 0, `look turned mid-comparison at ${t}s`);
  }
  assert.ok(held > 0, 'points are held, not merely passed through');
  // Each comparison begins and ends inside one chapter, so no cut lands in it.
  for (const start of Object.keys(POINTS_HOLD).map(Number)) {
    assert.equal(morph(start), 1, 'a comparison opens on whole bounds');
    let end = start;
    while (end < FLIGHT_DURATION && morph(end + 1 / 60) < 1) end += 1 / 60;
    assert.ok(FLIGHT_CHAPTERS.some((c) =>
      c.start <= film(start) && c.end >= film(end)), `comparison at ${start}s spans a cut`);
  }
});

test('the film only ever moves outward, allowing for drift and spline sag', () => {
  // The opener wanders inside the local field, and an arc flown through
  // control points on a sphere sags a little between them. Both are motion the
  // audience reads as steady; a leg that genuinely doubled back would not be.
  const opening = at(0).length();
  const { near, climb, side } = FLIGHT_CUTS;
  let radius = opening;
  for (const t of frames()) {
    if (t < 0) continue;
    const next = at(t).length();
    // The two climbing legs are held to the letter: they are the film's claim
    // about distance, and every decade in them has to be flown outward.
    const climbing = (t > near && t <= climb) || t > side;
    const slack = climbing ? 1e-7 : Math.max(opening * 0.1, radius * 0.005);
    assert.ok(next >= radius - slack, `moved inward at ${t}s`);
    radius = next;
  }
  assert.ok(at(FLIGHT_DURATION).length() > opening * 100, 'the film travels decades');
});

test('the climb gives every distance decade the same amount of time', () => {
  const { near, climb } = FLIGHT_CUTS;
  // Sampled across the middle of the leg, clear of the ramps at either end.
  // Equal time per decade means log radius is a straight line in time, so the
  // test is that its slope does not change rather than any particular value.
  const length = climb - near;
  const from = near + length * 0.2;
  const to = climb - length * 0.2;
  const decades = (t) => Math.log10(at(t).length());
  const slope = (a, b) => (decades(b) - decades(a)) / (b - a);
  const overall = slope(from, to);
  assert.ok(overall > 0, 'the climb covers ground');
  for (let i = 0; i < 8; i++) {
    const a = from + (to - from) * (i / 8);
    const b = from + (to - from) * ((i + 1) / 8);
    close(slope(a, b), overall, overall * 0.02);
  }
  assert.ok(decades(climb) - decades(near) >= 2, 'the climb covers at least two decades');
});

test('the side pass holds its radius and keeps Earth in frame, off-centre', () => {
  const { hold, side } = FLIGHT_CUTS;
  const radius = at(hold).length();
  let offset = 0;
  for (let t = hold; t <= side; t += 0.1) {
    const position = at(t);
    // An arc flown through control points on a sphere sags between them; what
    // matters is that the pass is a translation at distance, not a climb.
    close(position.length(), radius, radius * 0.02);
    const aim = targetAt(t).sub(position);
    assert.ok(aim.angleTo(position.clone().negate()) < Math.PI / 6, `Earth left frame at ${t}s`);
    assert.equal(morph(t), 1);
    offset = Math.max(offset, targetAt(t).length());
  }
  assert.ok(offset > 0, 'Earth moves off centre during the pass');
  // Far enough around Earth that the near field shifts against the far one.
  // A yaw in place would cover no ground at all.
  assert.ok(at(side).distanceTo(at(hold)) > radius * 0.5, 'the pass is a translation, not a yaw');
  assert.equal(targetAt(FLIGHT_DURATION).length(), 0, 'and returns to centre by the end');
});

test('the cut into the flight is the only discontinuity in the camera', () => {
  // Measured rather than compared against a fixed threshold: whatever the
  // score's scale, the one step taken behind full black must dwarf every step
  // the audience actually sees.
  const steps = [];
  let previous = filmAt(0);
  for (const t of frames()) {
    const position = filmAt(film(t));
    const step = position.distanceTo(previous);
    previous = position;
    steps.push({ t, step, hidden: flightDip(film(t)) === 1 });
  }
  const visible = Math.max(...steps.filter((s) => !s.hidden).map((s) => s.step));
  const cuts = steps.filter((s) => s.hidden && s.step > visible * 10);
  assert.equal(cuts.length, 1, 'exactly one cut');
  assert.ok(Math.abs(cuts[0].t) <= DIP.hold, 'the cut is behind full black');
  assert.deepEqual(filmAt(-1), filmAt(0), 'nothing before the film starts');
  assert.deepEqual(at(FLIGHT_DURATION + 10), at(FLIGHT_DURATION), 'the last frame holds');
});

test('velocity is continuous everywhere the audience can see it', () => {
  // A leg boundary must not show as a kick. Compared in proportion, because a
  // film that crosses decades has no single meaningful step size, with a floor
  // under it so the passages that start from rest are not judged against zero.
  const steps = [];
  let previous = filmAt(0);
  for (const t of frames()) {
    const position = filmAt(film(t));
    steps.push({ t, step: position.clone().sub(previous), hidden: flightDip(film(t)) > 0 });
    previous = position;
  }
  const visible = Math.max(...steps.filter((s) => !s.hidden).map((s) => s.step.length()));
  const floor = visible * 1e-3;
  let last = null;
  for (const { t, step, hidden } of steps) {
    if (hidden) {
      last = null;
      continue;
    }
    if (last) {
      const scale = Math.max(step.length(), last.length());
      assert.ok(step.distanceTo(last) <= scale * 0.25 + floor, `velocity jump at ${t}s`);
    }
    last = step;
  }
});

test('the treatment crosses once and settles before the film ends', () => {
  let previous = flightTreatmentMix(0);
  for (const t of frames()) {
    const mix = flightTreatmentMix(film(t));
    assert.ok(mix >= 0 && mix <= 1);
    assert.ok(mix >= previous - 1e-12, `treatment reversed at ${t}s`);
    previous = mix;
  }
  assert.equal(flightTreatmentMix(FLIGHT_SECONDS), 1);
  // The look returns to centre so the closing frame is square to the field.
  assert.equal(look(FLIGHT_DURATION), 0);
  for (const t of frames()) assert.ok(Math.abs(look(t)) <= Math.PI / 2);
});

test('subtitles are ordered, never overlap, fade from film time, and clear before the end', () => {
  assert.ok(FLIGHT_SUBTITLES.length > 0);
  FLIGHT_SUBTITLES.forEach((cue, i) => {
    assert.ok(cue.text.length > 0 && cue.text.length <= 70, cue.text);
    assert.ok(cue.end - cue.start >= 1.5, `readable: ${cue.text}`);
    // A gap at least as long as one fade keeps consecutive lines from mixing.
    if (i) assert.ok(cue.start - FLIGHT_SUBTITLES[i - 1].end >= SUBTITLE_FADE, cue.text);
    const middle = (cue.start + cue.end) / 2;
    assert.deepEqual(flightSubtitleAt(middle), { text: cue.text, opacity: 1 });
    assert.equal(flightSubtitleAt(cue.start).opacity, 0);
    assert.equal(flightSubtitleAt(cue.start).text, cue.text);
    close(flightSubtitleAt(cue.start + SUBTITLE_FADE / 2).opacity, 0.5);
    close(flightSubtitleAt(cue.end - SUBTITLE_FADE / 2).opacity, 0.5);
    assert.deepEqual(flightSubtitleAt(cue.end), { text: '', opacity: 0 });
  });
  assert.deepEqual(flightSubtitleAt(0), { text: '', opacity: 0 });
  assert.deepEqual(flightSubtitleAt(FLIGHT_SECONDS), { text: '', opacity: 0 });
  assert.ok(FLIGHT_SUBTITLES.at(-1).end < FLIGHT_SECONDS, 'closing frame carries no subtitle');
  for (const t of frames()) {
    const { text, opacity } = flightSubtitleAt(film(t));
    assert.ok(opacity >= 0 && opacity <= 1);
    if (text === '') assert.equal(opacity, 0);
  }
});

test('recording presents every film frame identically under jitter and stalls', () => {
  assert.equal(RECORD_PIXEL_RATIO, 2);
  assert.equal(RECORD_FPS, 60);
  const samples = (deltas) => {
    const clock = new FlightClock(true);
    const result = [];
    let now = 100;
    for (let tick = 0; result.at(-1) !== FLIGHT_SECONDS; tick++) {
      now += deltas[tick % deltas.length];
      const sample = clock.sample(now);
      if (sample !== null) result.push(sample);
      assert.ok(tick < 1_000_000);
    }
    return result;
  };
  const expected = Array.from(
    { length: Math.round(FLIGHT_SECONDS * RECORD_FPS) + 1 }, (_, i) => i / RECORD_FPS);
  assert.deepEqual(samples([1_000 / 144]), expected);
  assert.deepEqual(samples([4, 9, 21, 5, 16, 300]), expected);
});

test('recording caps cadence and pauses without jumping ahead after a stall', () => {
  const clock = new FlightClock(true);
  assert.equal(clock.sample(0), 0);
  assert.equal(clock.sample(8), null);
  assert.equal(clock.sample(16.667), 1 / 60);
  assert.equal(clock.sample(500), 2 / 60);
  assert.equal(clock.sample(501), null);
  clock.pause();
  assert.equal(clock.sample(50_000), 3 / 60);
});

test('normal playback lasts the film; hidden time pauses, restart resets', () => {
  const clock = new FlightClock(false);
  assert.equal(clock.sample(100), 0);
  assert.equal(clock.sample(10_100), 10);
  clock.pause();
  assert.equal(clock.sample(100_000), 10);
  assert.equal(clock.sample(100_000 + FLIGHT_SECONDS * 1_000), FLIGHT_SECONDS);
  assert.equal(new FlightClock(false).sample(1e9), 0);
  assert.equal(new FlightClock(true).sample(1e9), 0);
});
