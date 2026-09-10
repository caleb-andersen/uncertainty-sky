import assert from 'node:assert/strict';
import { test } from 'node:test';
import { FLIGHT_SECONDS, FLIGHT_SUBTITLES, RECORD_FPS, flightSubtitleAt } from '../src/flight.ts';
import { distanceLines, drawOverlay, overlayItems } from '../src/overlay.ts';

// A stand-in for canvas metrics: every glyph half an em wide. Proportional to
// the font size, which is all the layout depends on.
const measure = (text, font) => text.length * Number(/(\d+(?:\.\d+)?)px/.exec(font)[1]) * 0.5;
const items = (width, height, seconds, parsecs = 1_000) =>
  overlayItems(width, height, flightSubtitleAt(seconds), parsecs, measure);
const subtitles = (list) => list.filter((item) => item.align === 'center');
const counter = (list) => list.filter((item) => item.align === 'right');

// Wrapping is a property of a cue's length against the safe width, so the
// cases pick the shortest cue rather than naming a film time, and hand the
// wrap case its own line. A score is free to carry no cue long enough to wrap.
const byLength = [...FLIGHT_SUBTITLES].sort((a, b) => a.text.length - b.text.length);
const shortest = byLength[0];
const midway = (cue) => (cue.start + cue.end) / 2;
const laid = (text, width = 1280, height = 720) =>
  overlayItems(width, height, { text, opacity: 1 }, 1_000, measure);
// The width a subtitle line may not exceed on a 1280 x 720 frame: the smaller
// of REFERENCE.subtitleWidth and the 0.72 safe width.
const SAFE_WIDTH = Math.min(1280 * 0.72, 940);

test('the counter is always drawn; the subtitle only inside a cue', () => {
  const between = items(1280, 720, 0);
  assert.equal(between.length, 3);
  assert.deepEqual(between.map((item) => item.align), ['right', 'right', 'right']);
  assert.deepEqual(
    between.slice(1).map((item) => item.text), ['1,000 parsecs', '3,262 light years']);
  assert.ok(between.every((item) => item.opacity === 1));

  const during = items(1280, 720, midway(shortest));
  assert.equal(subtitles(during).length, 1);
  assert.equal(subtitles(during)[0].text, shortest.text);
  // The subtitle carries the cue's fade; the counter never fades.
  const fading = items(1280, 720, FLIGHT_SUBTITLES[0].start + 0.1);
  assert.ok(subtitles(fading)[0].opacity > 0 && subtitles(fading)[0].opacity < 1);
  assert.ok(counter(fading).every((item) => item.opacity === 1));
});

test('both units are named in full, with fewer digits as the number grows', () => {
  // The catalogue's parsecs, and the same radius converted. Neither line is
  // rounded to a friendlier number, and neither unit is abbreviated: 'pc'
  // means nothing to a viewer meeting it for the first time.
  assert.deepEqual(distanceLines(1), ['1.00 parsecs', '3.26 light years']);
  assert.deepEqual(distanceLines(4), ['4.00 parsecs', '13 light years']);
  assert.deepEqual(distanceLines(100), ['100 parsecs', '326.2 light years']);
  assert.deepEqual(distanceLines(2_000), ['2,000 parsecs', '6,523 light years']);
  assert.deepEqual(distanceLines(20_000), ['20,000 parsecs', '65,231 light years']);
  // Both lines rise together across the whole flight, and neither goes bare.
  let previous = [-Infinity, -Infinity];
  for (let pc = 1; pc <= 20_000; pc *= 1.05) {
    const lines = distanceLines(pc);
    assert.match(lines[0], /^[\d,.]+ parsecs$/);
    assert.match(lines[1], /^[\d,.]+ light years$/);
    const values = lines.map((line) => Number(line.replace(/[^\d.]/g, '')));
    values.forEach((value, index) => assert.ok(value >= previous[index], lines[index]));
    previous = values;
  }
});

test('the counter stacks its two units on one right edge', () => {
  const [label, parsecs, lightYears] = counter(items(1280, 720, 0, 1));
  // A shared right edge is what keeps the block flush as digits come and go.
  assert.ok([parsecs, lightYears].every((item) => item.x === label.x));
  assert.deepEqual([parsecs.text, lightYears.text], ['1.00 parsecs', '3.26 light years']);
  const size = (item) => Number(/(\d+(?:\.\d+)?)px/.exec(item.font)[1]);
  // Converted, so it reads as the same fact restated, not a second measurement.
  assert.ok(size(lightYears) < size(parsecs));
  // Stacked in order, and the lines clear each other.
  assert.ok(label.y < parsecs.y);
  assert.ok(lightYears.y >= parsecs.y + size(parsecs));
});

test('sizes and positions scale with frame height, so exports match the window', () => {
  const small = items(1280, 720, 3);
  const large = items(2560, 1440, 3);
  assert.equal(small.length, large.length);
  small.forEach((item, index) => {
    const size = (value) => Number(/(\d+(?:\.\d+)?)px/.exec(value.font)[1]);
    assert.ok(Math.abs(size(large[index]) - size(item) * 2) < 1e-9, item.text);
    assert.ok(Math.abs(large[index].y - item.y * 2) < 1e-9, item.text);
  });
  // 16:9 at either size puts the counter and the subtitle in the same place.
  assert.ok(Math.abs((2560 - large[0].x) - (1280 - small[0].x) * 2) < 1e-9);
});

test('a long cue wraps to two balanced lines that both fit', () => {
  const text = 'A line of narration long enough that the overlay has to wrap it.';
  const lines = subtitles(laid(text));
  assert.equal(lines.length, 2);
  assert.equal(lines.map((line) => line.text).join(' '), text);
  const widths = lines.map((line) => measure(line.text, line.font));
  assert.ok(widths.every((width) => width <= SAFE_WIDTH), `${widths} exceed ${SAFE_WIDTH}`);
  // Balanced, not greedy: a greedy break would leave the second line far shorter.
  assert.ok(Math.abs(widths[0] - widths[1]) < SAFE_WIDTH * 0.35, `${widths}`);
  // Lines stack upward from one baseline, so the last never moves: a wrapped
  // cue ends where a cue that fits on one line sits.
  assert.ok(lines[0].y < lines[1].y);
  assert.equal(lines[1].y, subtitles(items(1280, 720, midway(shortest)))[0].y);
});

test('every exported frame lays out inside the frame', () => {
  for (let frame = 0; frame < FLIGHT_SECONDS * RECORD_FPS; frame += 7) {
    const seconds = frame / RECORD_FPS;
    const list = items(1920, 1080, seconds, 20_000);
    assert.equal(list.length, subtitles(list).length + 3);
    assert.equal(subtitles(list).length > 0, flightSubtitleAt(seconds).opacity > 0);
    for (const item of list) {
      assert.ok(item.y > 0 && item.y < 1080, `${item.text} at y ${item.y}`);
      const width = measure(item.text, item.font);
      const left = item.align === 'center' ? item.x - width / 2 : item.x - width;
      assert.ok(left > 0 && left + width < 1920, `${item.text} spans ${left}..${left + width}`);
      assert.ok(item.opacity >= 0 && item.opacity <= 1);
    }
  }
});

// A stand-in for a 2D context that records what was asked of it. Enough of the
// surface for drawOverlay: the layout is checked against real metrics above.
function recordingContext() {
  const calls = [];
  const record = (name) => (...args) => calls.push([name, ...args]);
  return {
    calls, save: record('save'), restore: record('restore'),
    clearRect: record('clearRect'), fillRect: record('fillRect'),
    fillText: record('fillText'),
    measureText: (text) => ({ width: text.length * 8 }),
    font: '', letterSpacing: '', textAlign: '', textBaseline: '',
    fillStyle: '', globalAlpha: 1, shadowColor: '', shadowBlur: 0, shadowOffsetY: 0,
  };
}

test('the overlay paints over the frame it is given and never clears it', () => {
  // The export draws the rendered sky, then this: a clear would wipe the sky
  // and leave the text on black, which is exactly what a viewer would see.
  const ctx = recordingContext();
  drawOverlay(ctx, 1920, 1080, flightSubtitleAt(midway(FLIGHT_SUBTITLES[0])), 1.05);
  assert.deepEqual(ctx.calls.filter(([name]) => name === 'clearRect'), []);
  assert.ok(ctx.calls.some(([name, text]) => name === 'fillText' && text === FLIGHT_SUBTITLES[0].text));
  const painted = (text) => ctx.calls.some(([name, drawn]) => name === 'fillText' && drawn === text);
  assert.ok(painted('1.05 parsecs') && painted('3.42 light years'));
  // Nothing is filled across the whole frame while there is no dip.
  assert.deepEqual(ctx.calls.filter(([name]) => name === 'fillRect'), []);
});
