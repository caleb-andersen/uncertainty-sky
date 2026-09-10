# Renderer

From `web`, run `npm ci`, then `npm run dev`. `npm run build` type-checks and
builds the production bundle; `npm run preview` serves that bundle locally.
Node 22.12+ is required by the build tooling.

The catalogue is not included. Run the existing pipeline through `pack.py` to
populate `public/data/meta.json` and its five `.bin` files. Missing data produces
an explicit error, with no substitute stars. The loader validates the packer
layout, fetches all five attributes concurrently, and streams directly into
preallocated buffers (108 MB total for 2 million stars). It retains raw scalar
codes and their zero sentinels, and the shader decodes them with the manifest's
own rules.

One non-indexed `BufferGeometry` and one `LineSegments` object draw every packed
pair in a single call, with no sampling or per-star JavaScript in the animation
loop. `src/starMaterial.ts` replaces the scaffold's `LineBasicMaterial` with a
`ShaderMaterial` that consumes all five attributes. The loader renames the
scalar channels on the way in (`color.bin` becomes `bpRpCode`, and so on)
because Three.js reserves the attribute name `color` for RGB vertex colours,
and these are quantised codes, not colours. It also validates the packer's
decode block, so a pipeline that moves a domain or drops a sentinel fails
loudly instead of silently recolouring the sky.

## What the shader draws

`morph` lerps every vertex between the star's midpoint and its true bound, so
at any setting the drawn segment is a centred sub-interval of the measured one.
Only `morph` 1.000 shows the catalogue's endpoints; the UI says so, because a
half-length streak is a display transition and not a narrower measurement.
Near/far and the line of sight are derived in the shader from `midpoint`, which
`bounds.py` guarantees is colinear with both endpoints, so no sixth buffer is
needed.

Three things are display decisions, not data, and all three are disclosed on
screen:

- A collapsed star draws as a mark of `mark` pixels rather than a zero-length
  line the rasteriser would drop.
- A star's light is smeared along its uncertainty, so a longer streak is drawn
  fainter. `spread` sets how much of that conservation applies.
- Brightness falls off with distance from the camera, relative to the orbit
  radius so flying outward does not just dim everything. It is applied per star
  from the midpoint, so it is constant along a streak. Fading *along* a streak
  is reserved for one thing only: a far endpoint that is not a measurement.

Colour is `src/palette.ts`: observed BP-RP to an approximate main-sequence
effective temperature, then a tabulated Planckian locus to sRGB, built once per
treatment into a 256-entry lookup and sampled in the vertex shader. It is
uncorrected for interstellar reddening, so a reddened hot star reads cool. Code
0 is the packer's "not measured" sentinel: it gets its own reserved slot, and
those stars are stippled along their length so they cannot be mistaken for a
measured hue. Far endpoints flagged 1 (clamped at the horizon) or 2 (lower
parallax non-positive, formally infinite) dissolve toward transparent instead of
ending on a hard edge, flag 2 starting earlier because its endpoint is the more
arbitrary. The on-screen legend samples the same lookup the GPU was handed and
quotes the packer's own counts.

## Treatments

`src/treatments.ts` holds three, switchable at runtime; they change emphasis and
exposure only, never geometry or decoding.

- **Plate** - warm near-black, full stellar colour, light conserved as it
  smears. Well-measured stars stay sharp; uncertain ones ghost.
- **Graphite** - cool charcoal, colour pulled almost to monochrome, little
  smear normalisation. The whole web stays legible.
- **Confidence** - neutral black, steep magnitude response, light fully
  conserved. Uncertainty dissolves as it stretches and only a sparse,
  well-measured field survives the morph.

The material is one unordered additive layer with depth testing off, so the
renderer's logarithmic depth buffer is inert for it; nothing in the scene reads
or writes depth. The camera orbits Earth in right-handed ICRS coordinates (+Z
north). Panning is disabled so OrbitControls' 1–20,000 pc radius limits are
distances from Earth.
Use drag to orbit, wheel/pinch to dolly, or the logarithmic slider to cross the
whole range. The two buttons jump to exact limits. The renderer requests a
logarithmic depth buffer with a 0.001 pc near plane; the far plane encloses the
catalogue even when the camera is at 20,000 pc. See the
[Three.js renderer documentation](https://threejs.org/docs/pages/WebGLRenderer.html)
for the depth-buffer performance tradeoff.

## The score

The film is separated from the machinery that plays it.

`src/flight.ts` is the projector: easing, the spline inversion that gives every
distance decade equal time, the subtitle fader, the frame-indexed recording
clock, and the checks that reject a malformed score. It contains no waypoint, no
cut time and no line of narration.

`src/score.ts` is the film: where the camera goes, when it cuts, and what the
cards say. It is **not committed**. The renderer is MIT; a score is not, because
the choreography and the writing are the authored work rather than the code that
executes them. See `NOTICE`.

A fresh clone therefore has no `src/score.ts`. `scripts/score.mjs` copies
`src/score.example.ts` into place, and `dev`, `build`, `test` and `export` all
run it first, so the repo works out of the box. The example is a short, plain
flight that exists to demonstrate the shape and keep the renderer exercisable.
It is not the film published from this project. Copy it, rewrite it, and your
own flight stays yours.

`src/scoreTypes.ts` defines the shape a score must take. A score is verified
once on load and rejected loudly rather than played wrong: shots must be
contiguous and cover the flight, and every leg must end on a shot boundary, or a
camera discontinuity would land inside a shot where no dip is covering it.

Tests split the same way. `tests/flight.test.mjs` holds the invariants every
score must satisfy and passes against the example as readily as against the
author's film. `tests/score.test.mjs` pins the current score's own numbers and
is not committed.

Nothing in a score can touch the catalogue. It moves the camera and writes the
captions; parallaxes, error bars and drawn segments are beyond its reach.

## Scripted flight and recording

After the catalogue loads, press **F** (or **Fly**) for a 98-second film: a
20-second prologue, then the 78-second flight. F restarts from the prologue;
**Escape** returns to orbit controls at the current camera position, facing
Earth. The film stops Sweep and disables orbit input. The cursor and page
chrome are hidden. It is presented as a film, with two things on screen and
nothing else:

- **Distance from Earth**, small in the top-right corner: the camera's actual
  distance, on two lines under one label. The catalogue's own parsecs first,
  then the same radius in light years, which is the unit the subtitles use and
  the one a viewer who has never met a parsec can picture. Both units are
  spelled out, and both lines share the label's right edge so the block stays
  flush as digits come and go. The conversion is exact by definition, and
  digits fall as the number grows: two decimals near Earth, one out to a
  thousand, none beyond. This is the camera's position in the visualization,
  not a new stellar distance measurement. `distanceLines` in `src/overlay.ts`
  formats both from one radius, so the two can never disagree.
- **Subtitles**, bottom-centre: a line of a few words at a time, timed to the
  shots, from `FLIGHT_SUBTITLES`, which the projector builds from the score
  it was handed. The prologue's cards
  explain the notation; every line after them describes only what the frame is
  showing at that moment. Lines never overlap; each fades in and out over
  `SUBTITLE_FADE` (0.35s), with at least that gap between cues, and the last
  clears before the closing frame.

Both are painted on a canvas over the sky by `src/overlay.ts`, which the video
export runs over the same rendered frame, so what you watch and what lands in
the file come from one implementation. Sizes are fractions of the frame height
against a 720-high reference, which keeps a 1080p export and a 720p window
proportionally identical. The page also keeps a silent copy of the current
subtitle in an `aria-live` region for assistive technology.

The fade is computed from film time rather than by a CSS transition: playback
that cannot hold the frame rate advances film time more slowly than the wall
clock, and a transition would drift out of step with the cut it belongs to.

The prologue's five cards are the only lines that explain the notation rather
than describe the shot. They are written for someone who has never seen the
picture: no unit is used at all, and one idea lands per card. Cards three and
four straddle the expansion, so the change is read while it happens.

The cards themselves are not reproduced here. Narration is part of the score
and the score is not committed; see **The score** below.

Only the prologue's times are written as film time. The
flight's cues keep their own clock and are shifted by `PROLOGUE_SECONDS` once,
where the two lists are concatenated, so changing the prologue's length never
moves one of them.

Normal completion restores the UI; recording holds the closing frame and the
counter until Escape or another F. Switching away from the tab pauses
playback. Interactive playback is wall-clock timed, so a long stall skips film
time and can pass over a short cue; recording is frame-indexed and shows every
one.

The chapter boundaries are exported as `FLIGHT_CHAPTERS`:

The shots are not listed here for the same reason. Their labels and boundaries
come from the score, and `FLIGHT_CHAPTERS` is what the UI reads.

The prologue holds the same 2,000 pc anchor the flight's first comparison uses,
drifting six degrees around ICRS north onto it. That radius is not a
preference. A point field only reads where the catalogue concentrates in front
of the camera: from inside the local field at 1 pc every mark is a lone pixel
and the frame is empty, which is the opposite of what the cards claim. The
prologue expands to morph 1 before the flight begins, which is the state the
flight's first frame already assumed, so nothing about the choreography
changed.

Ending at 2,000 pc and starting the flight at 1 pc is a jump in both the frame
and the counter, and no camera move joins them honestly, so the film cuts.
`flightDip` blacks the whole frame out across that cut, counter and subtitle
included, holding full black for 0.15s on either side so the change of position
is never on screen. `src/overlay.ts` paints it last, over everything, in the
same routine the export uses. It is the only edit in the film that is not
continuous, and the only fade; `flightDip` is zero at every other frame, and
the tests assert both that and that exactly one position discontinuity exists.

Every function in `src/flight.ts` takes film time; the flight's own cut points
appear only after `seconds - PROLOGUE_SECONDS`, which is why the flight-time
column above is what the source and the tests both read.

The camera follows centripetal Catmull–Rom splines, with ICRS +Z up. Outward
legs invert a precomputed radius lookup on the spline: 10→100 and 100→1,000 pc
each take about 7.35 seconds. Only two-second acceleration/braking windows
deviate from the constant log speed. The lateral beat changes position, not
just heading. Both morph comparisons hold position and orientation still.

Every take starts in Plate and finishes in Confidence. Escape during playback
restores the treatment selected before the take; completing it keeps Confidence.
Endpoint colour ramps are prepared before playback, then their 1 KiB of bytes
are blended into a reusable buffer during the crossfade. The texture is uploaded
only when the blend changes; the shader keeps one ramp lookup per vertex. Numeric
uniforms interpolate, including falloff, tail dissolves and stipple; gain uses
logarithmic interpolation to avoid a large exposure spike between 12 and 2,200.
Ground colour interpolates in linear colour space. These are display treatments,
not a filter for measured confidence or a guarantee of a particular star count.

The 15,000 pc endpoint looks back into the structure without trying to fit it
inside the frame: the current development export extends to 20,000 pc. The
0.001 pc near plane lets close segments cross the camera; the GPU clips the
lines against the view volume without moving catalogue endpoints onto the plane.

## Exporting a video file

`npm run export` writes a finished MP4 with the soundtrack. Prefer it over
screen capture: it is deterministic. The page renders film frame *n* as film
second *n* / 60, posts it to the export script, and waits for the encoder to
take it before drawing the next one, so no frame is ever dropped, duplicated or
early. A slow machine makes the export take longer and changes nothing about
the result.

It needs **ffmpeg** on `PATH`. On Windows:

```sh
winget install --id Gyan.FFmpeg -e
```

Open a new terminal afterwards so `PATH` is picked up, or pass
`--ffmpeg <path to ffmpeg.exe>`. Then, from `web`:

```sh
npm run export
```

That builds, starts a local server, opens a browser tab, and renders. Keep the
tab in front until it reports it is complete. Frames are piped straight into
ffmpeg, so a 98-second film never lands on disk as thousands of stills. The
default is 1920 × 1080 at 60 fps to `exports/uncertainty-sky.mp4`, which the
repository ignores.

| Option | Default | |
| --- | --- | --- |
| `--width`, `--height` | 1920 × 1080 | Both must be even, for x264 with `yuv420p`. |
| `--seconds` | the film's length | Export only the opening *n* seconds, to check a change quickly. |
| `--out` | `exports/uncertainty-sky.mp4` | |
| `--music` | `music/soundtrack.mp3` | |
| `--crf` | 16 | x264 quality; lower is better and larger. |
| `--ffmpeg` | `ffmpeg` | Also read from the `FFMPEG` environment variable. |
| `--no-audio-fade` | fade on | Keep the soundtrack's own ending instead. |
| `--no-open` | opens | Print the URL rather than opening a browser. |

Pass options after `--`, as in `npm run export -- --width 2560 --height 1440`.

The sky is rendered at twice the video's resolution and downsampled into each
frame, the same supersampling the on-screen recording mode uses: a 1080p export
draws at 3840 × 2160. That cost dominates the export, and it is fill-rate bound,
so it grows as the sky fills with streaks and it depends heavily on the GPU. The
script prints a running estimate from the frames it has already taken; use
`--seconds` to check a change before committing to the full 98.

**Audio.** The soundtrack starts at 0:00 and the film is the master: the output
is exactly 98 seconds, so a longer track is cut to that length and a shorter one
simply ends early. `music/soundtrack.mp3` runs 2:07, so it is cut at 98s, with a
two-second fade-out so it does not stop dead. Pass `--no-audio-fade` to hear the
cut as it falls. The mp3 lives outside `public/`, so it is never shipped in the
web bundle; only the export reads it.

## Screen capture

For screen capture instead, run either command from `web`:

```sh
npm run dev -- --record
# Or build first, then capture the production bundle:
npm run build
npm run preview -- --record
```

The flag opens `/?record`; that URL also enables recording on an already running
server. Wait for loading to finish, set your viewport, start your
screen recorder at **60 fps**, then press F. The app hides its own chrome except
the distance counter and subtitles; capture the canvas/window content or enter
browser fullscreen to exclude browser toolbars. The flag does not start a screen
recorder or create a video file. Before the take, check the fps readout in the
panel at **20,000 pc**: recording is frame-indexed, so a machine that cannot hold
60 fps at your window size plays the film slower than 98 seconds rather than
dropping frames, and a screen recorder would capture that slow playback. Use a
smaller window if the readout falls short.

Recording uses pixel ratio **2**: a 1280 × 720 viewport draws at 2560 × 1440,
then the browser downsamples it. Mark lengths and stipple periods scale with
pixel ratio to keep their CSS-pixel sizes. This costs four times the pixels;
it is not free. Interactive mode keeps pixel ratio 1.

Recording renders one frame per 1/60-second film step and caps presentation at
60 Hz. It presents all 5,881 samples including t=0 and t=98, then holds t=98.
Camera, morph and treatment depend on the frame number, so delayed callbacks
do not skip film frames. If rendering cannot sustain 60 fps, playback takes
longer than 98 seconds of wall time; an external screen recorder can still drop
or duplicate frames. Fixed steps alone do not make a slow screen capture smooth.
Prefer the production preview and a foreground browser window.

## Verification

- `npm run build`: strict TypeScript check and production build.
- `npm test`: stream layout, parallel download/progress, truncation, missing
  manifest and decode-rule checks, plus the colour ramp (temperature monotonic
  and anchored, locus never green, sentinel slot reserved, legend gradient built
  from the same bytes). Byte fixtures are isolated tests, never shown as stars.
  Overlay tests cover the counter in both units and the right edge it stacks
  them on, cue-driven subtitles, height-proportional
  scaling, balanced wrapping within the safe width, and every exported frame
  laying out inside the frame.
  Flight tests cover chapter continuity, subtitle ordering, spacing and fades
  at every recorded frame, both stationary comparisons, the local
  drift, equal decade timing, lateral displacement and convergence framing,
  smooth motion, treatment timing, all recording frames under jitter and stalls,
  pause and restart. Material tests cover ramp caching/buffer reuse, treatment
  uniform interpolation, exposure, and supersampling viewport parameters.
- Browser checks (2026-09-09), real 49,969-star export in production preview:
  distance counter and subtitles through the flight at 1280 × 720 and at
  375 px wide, local opener, lateral convergence framing, completion
  at 15,000 pc with Confidence / morph 1, and closing points view checked visually.
  Recording reports 2560 × 1440 for a 1280 × 720 viewport. F works after treatment
  selection; Escape restores that selection on cancellation. External capture
  pacing and the full 2-million-star performance target remain unverified.
- In the browser, click **1 pc**, then **20,000 pc**, and check the distance
  readout; wheel farther in/out to confirm the clamps. Drag at both limits.
- With an actual 2-million-star export, use the production preview, let upload
  finish, then watch the live segment count, FPS, draw-call count and resolution.
  Check while orbiting at 1, 1,000 and 20,000 pc. Expect 2,000,000 segments and
  one draw call; record hardware, viewport, and observed FPS when benchmarking.
  Use interactive mode (pixel ratio 1, MSAA off) for the laptop target;
  recording mode deliberately spends more GPU time on supersampling.

The 60 fps target cannot be certified without the real catalogue and a hardware
measurement. A blank scene's frame rate is deliberately not reported.

Scaffold verification (2026-09-08): production build and all four loader tests
passed. Browser checks at 1280 × 720 confirmed both radius buttons, wheel clamps
at 1 and 20,000 pc, wheel travel away from the inner limit, and stable distance
while dragging at both limits. Missing-catalogue messaging was also verified.
`public/data` contained only `.gitkeep`, so loaded-sky rendering, visual depth
correctness and the 2-million-segment performance target remain unverified.

Shader verification (2026-09-08): build and all eleven tests passed. Rendered at
1280 × 760 against a 49,969-star development export on an Intel Arc 140V. The
morph was scrubbed across its whole range in both directions and with Sweep, and
all three treatments were checked at 1,000 pc. The sentinel and stipple paths
were confirmed by temporarily writing a flag colour into ramp slot 0: exactly the
3,427 stars with no BP-RP took it, and dropping the duty cycle dimmed that set
alone. Those stars turn out to concentrate hard in the Galactic plane.

GPU time for the draw, measured with `EXT_disjoint_timer_query_webgl2` at full
morph with the camera at 1,000 pc, was 2.2 ms median over 40 frames. Keeping the
ramp lookup in the vertex shader and keeping the `discard` were both chosen on
that measurement (2.2 ms against 2.9 ms without the discard). Note that wall-clock
FPS inside an embedded browser pane is not trustworthy: frames there alternated
between 8 ms and multi-second stalls that the timer query shows are not the draw.
Measure FPS in a real browser window. The 2-million-segment target still needs the
full catalogue and a recorded hardware measurement.
