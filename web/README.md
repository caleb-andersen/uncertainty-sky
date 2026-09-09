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

## Scripted flight and recording

After the catalogue loads, press **F** (or **Fly**) for a 78-second flight.
F restarts from the local field; **Escape** returns to orbit controls at the
current camera position, facing Earth. The flight stops Sweep and disables orbit
input. The cursor and page chrome are hidden. The flight is presented as a
film, with two things on screen and nothing else:

- **Distance from Earth**, small in the top-right corner: the camera's actual
  distance, with two decimal places below 10 pc. This is the camera's position
  in the visualization, not a new stellar distance measurement.
- **Subtitles**, bottom-centre: a line of a few words at a time, timed to the
  shots, from `FLIGHT_SUBTITLES` in `src/flight.ts`. Each line describes only
  what the frame is showing at that moment. Lines never overlap; each fades in
  and out over `SUBTITLE_FADE` (0.35s), with at least that gap between cues, and
  the last clears before the closing frame.

The fade is computed from film time rather than by a CSS transition: playback
that cannot hold the frame rate advances film time more slowly than the wall
clock, and a transition would drift out of step with the cut it belongs to.

| Film time | Subtitle |
| --- | --- |
| 1–5s | One parsec from Earth. The nearest stars. |
| 5.5–9.5s | Each streak is one star's distance uncertainty. |
| 12–16s | Leaving the solar neighbourhood. |
| 21–25.5s | Farther out, distances are known less well. |
| 28.5–33.5s | Distant stars stretch into spears. |
| 36.5–38.6s | Drawn as points: an ordinary star map. |
| 39–42s | Drawn as measured: a range of possible distances. |
| 43.5–48s | Every streak points back at Earth. |
| 49–53.5s | Uncertainty lies along the line of sight. |
| 55.5–60s | Outward, to fifteen thousand parsecs. |
| 65–69.5s | Longer streaks now drawn fainter. The well-measured stars remain. |
| 70.6–73.5s | Every star map looks like this. |
| 73.9–77.4s | This is how well each distance is known. |

Normal completion restores the UI; recording holds the closing frame and the
counter until Escape or another F. Switching away from the tab pauses
playback. Interactive playback is wall-clock timed, so a long stall skips film
time and can pass over a short cue; recording is frame-indexed and shows every
one.

The chapter boundaries are exported as `FLIGHT_CHAPTERS` in `src/flight.ts`:

| Film time | Shot |
| --- | --- |
| 0–10s | Drift about 0.8 pc through the local field at roughly 1 pc, morph 1. |
| 10–36s | Travel to 2,000 pc at constant log-distance speed, with smooth acceleration and braking. |
| 36–42s | Stationary comparison: collapse 36–37.5s, points until 38.5s, expand to 40s, hold bounds. |
| 42–54s | A 75° lateral arc at about 2,000 pc: over 2,300 pc of translation, keeping Earth's convergence point in frame. |
| 54–64s | Continue at the same log-distance speed to 15,000 pc, arriving around 62.4s; settle and look across the field. |
| 64–70s | Crossfade Plate → Confidence and turn back toward Earth. |
| 70–74.6s | Stationary closing comparison: 1.5s collapse, 1.6s points (`POINTS_HOLD`), 1.5s re-expansion. |
| 74.6–78s | Hold Confidence at the catalogue's full bounds. |

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

For screen capture, run either command from `web`:

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
60 fps at your window size plays the film slower than 78 seconds rather than
dropping frames, and a screen recorder would capture that slow playback. Use a
smaller window if the readout falls short.

Recording uses pixel ratio **2**: a 1280 × 720 viewport draws at 2560 × 1440,
then the browser downsamples it. Mark lengths and stipple periods scale with
pixel ratio to keep their CSS-pixel sizes. This costs four times the pixels;
it is not free. Interactive mode keeps pixel ratio 1.

Recording renders one frame per 1/60-second film step and caps presentation at
60 Hz. It presents all 4,681 samples including t=0 and t=78, then holds t=78.
Camera, morph and treatment depend on the frame number, so delayed callbacks
do not skip film frames. If rendering cannot sustain 60 fps, playback takes
longer than 78 seconds of wall time; an external screen recorder can still drop
or duplicate frames. Fixed steps alone do not make a slow screen capture smooth.
Prefer the production preview and a foreground browser window.

## Verification

- `npm run build`: strict TypeScript check and production build.
- `npm test`: stream layout, parallel download/progress, truncation, missing
  manifest and decode-rule checks, plus the colour ramp (temperature monotonic
  and anchored, locus never green, sentinel slot reserved, legend gradient built
  from the same bytes). Byte fixtures are isolated tests, never shown as stars.
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
