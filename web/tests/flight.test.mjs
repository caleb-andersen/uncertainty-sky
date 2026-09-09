import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Vector3 } from 'three';
import {
  createFlightPath, FlightClock, flightLookOffset, flightMorph, flightSubtitleAt,
  flightTreatmentMix, FLIGHT_CHAPTERS, FLIGHT_SECONDS, FLIGHT_SUBTITLES, POINTS_HOLD,
  RECORD_FPS, RECORD_PIXEL_RATIO, SUBTITLE_FADE,
} from '../src/flight.ts';

const path = createFlightPath();
const at = (seconds) => path.positionAt(seconds, new Vector3());
const close = (a, b, epsilon = 1e-7) => assert.ok(Math.abs(a - b) < epsilon, `${a} != ${b}`);

test('78 seconds of contiguous chapters, ten seconds drifting through the local field', () => {
  assert.equal(FLIGHT_SECONDS, 78);
  assert.equal(FLIGHT_CHAPTERS[0].start, 0);
  assert.equal(FLIGHT_CHAPTERS.at(-1).end, FLIGHT_SECONDS);
  FLIGHT_CHAPTERS.slice(1).forEach((chapter, i) => assert.equal(chapter.start, FLIGHT_CHAPTERS[i].end));
  for (let t = 0; t <= 10; t += 0.1) {
    assert.ok(at(t).length() >= 0.999 && at(t).length() < 1.1);
    assert.equal(flightMorph(t), 1);
  }
  assert.ok(at(10).distanceTo(at(0)) > 0.8, 'opener translates through local space');
});

test('both distance comparisons collapse, hold points, then re-expand in place', () => {
  assert.deepEqual(POINTS_HOLD, { 36: 1, 70: 1.6 });
  for (const start of [36, 70]) {
    const hold = POINTS_HOLD[start];
    const position = at(start);
    close(position.length(), start === 36 ? 2_000 : 15_000);
    assert.equal(flightMorph(start), 1);
    assert.equal(flightMorph(start + 0.75), 0.5);
    for (let i = 0; i <= hold * 60; i++) assert.equal(flightMorph(start + 1.5 + i / 60), 0);
    assert.equal(flightMorph(start + 2.25 + hold), 0.5);
    assert.equal(flightMorph(start + 3 + hold), 1);
    for (let t = start; t <= start + 3 + hold; t += 1 / 60) {
      assert.deepEqual(at(t), position);
      assert.equal(flightLookOffset(t), 0);
      assert.ok(flightMorph(t) >= 0 && flightMorph(t) <= 1);
    }
    // The comparison finishes inside its own chapter.
    assert.ok(FLIGHT_CHAPTERS.some((c) => c.start === start && c.end >= start + 3 + hold));
  }
  for (const t of [0, 10, 20, 35, 41, 50, 69, 74.6, 78, 90]) assert.equal(flightMorph(t), 1);
});

test('outward legs give decades equal time with smooth starts and stops', () => {
  const crossing = (radius) => {
    let low = 10;
    let high = 36;
    for (let i = 0; i < 40; i++) {
      const middle = (low + high) / 2;
      if (at(middle).length() < radius) low = middle;
      else high = middle;
    }
    return (low + high) / 2;
  };
  const decade = crossing(100) - crossing(10);
  close(crossing(1_000) - crossing(100), decade, 0.001);
  close(Math.log10(at(59).length() / at(57).length()), 2 / decade, 0.001);
  assert.ok(at(26).length() > 100, 'middle of the film no longer stays inside 10 pc');
  for (const [start, end] of [[10, 36], [54, 64]]) {
    let radius = at(start).length();
    for (let t = start; t <= end; t += 1 / 60) {
      const next = at(t).length();
      assert.ok(next >= radius - 1e-7);
      radius = next;
    }
  }
});

test('side pass translates over 2,300 pc and keeps Earth visible off-centre', () => {
  assert.ok(at(54).distanceTo(at(42)) > 2_300);
  for (let t = 42; t <= 54; t += 0.1) {
    const position = at(t);
    assert.ok(position.length() > 1_950 && position.length() < 2_010);
    const aim = path.targetAt(t, new Vector3()).sub(position);
    assert.ok(aim.angleTo(position.clone().negate()) < Math.PI / 6);
    assert.equal(flightMorph(t), 1);
  }
  assert.ok(path.targetAt(48, new Vector3()).length() > 400);
});

test('camera and look settle for the closing comparison; no jumps across chapter boundaries', () => {
  assert.deepEqual(at(-1), at(0));
  assert.deepEqual(at(90), at(78));
  close(at(78).length(), 15_000);
  assert.equal(flightLookOffset(70), 0);
  assert.equal(path.targetAt(78, new Vector3()).length(), 0);
  assert.ok(flightLookOffset(64) > flightLookOffset(67));
  assert.equal(flightTreatmentMix(64), 0);
  assert.equal(flightTreatmentMix(67), 0.5);
  assert.equal(flightTreatmentMix(70), 1);
  let previous = at(0);
  let previousStep = new Vector3();
  for (let frame = 0; frame <= FLIGHT_SECONDS * RECORD_FPS; frame++) {
    const position = at(frame / RECORD_FPS);
    const step = position.clone().sub(previous);
    assert.ok(step.length() < 65, `position jump at frame ${frame}`);
    assert.ok(step.clone().sub(previousStep).length() < 1, `velocity jump at frame ${frame}`);
    previous = position;
    previousStep = step;
  }
});

test('60 fps recording presents all 4,681 samples identically under jitter and stalls', () => {
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
      assert.ok(tick < 100_000);
    }
    return result;
  };
  const expected = Array.from({ length: 4_681 }, (_, i) => i / 60);
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

test('normal playback lasts 78 active seconds; hidden time pauses, restart resets', () => {
  const clock = new FlightClock(false);
  assert.equal(clock.sample(100), 0);
  assert.equal(clock.sample(10_100), 10);
  clock.pause();
  assert.equal(clock.sample(100_000), 10);
  assert.equal(clock.sample(126_000), 36);
  assert.equal(clock.sample(168_000), 78);
  assert.equal(clock.sample(169_000), 78);
  assert.equal(new FlightClock(false).sample(169_000), 0);
  assert.equal(new FlightClock(true).sample(169_000), 0);
});

test('subtitles are ordered, never overlap, fade from film time, and clear before the end', () => {
  assert.ok(FLIGHT_SUBTITLES.length >= 10);
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
  // The stationary comparisons are captioned while their points are held.
  assert.equal(flightSubtitleAt(38).opacity, 1);
  assert.equal(flightSubtitleAt(72).opacity, 1);
  assert.deepEqual(flightSubtitleAt(0), { text: '', opacity: 0 });
  assert.deepEqual(flightSubtitleAt(FLIGHT_SECONDS), { text: '', opacity: 0 });
  assert.ok(FLIGHT_SUBTITLES.at(-1).end < FLIGHT_SECONDS, 'closing frame carries no subtitle');
  for (let frame = 0; frame <= FLIGHT_SECONDS * RECORD_FPS; frame++) {
    const { text, opacity } = flightSubtitleAt(frame / RECORD_FPS);
    assert.ok(opacity >= 0 && opacity <= 1);
    if (text === '') assert.equal(opacity, 0);
  }
});
