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
logarithmic depth buffer with a 0.01 pc near plane; the far plane encloses the
catalogue even when the camera is at 20,000 pc. See the
[Three.js renderer documentation](https://threejs.org/docs/pages/WebGLRenderer.html)
for the depth-buffer performance tradeoff.

## Verification

- `npm run build`: strict TypeScript check and production build.
- `npm test`: stream layout, parallel download/progress, truncation, missing
  manifest and decode-rule checks, plus the colour ramp (temperature monotonic
  and anchored, locus never green, sentinel slot reserved, legend gradient built
  from the same bytes). Byte fixtures are isolated tests, never shown as stars.
- In the browser, click **1 pc**, then **20,000 pc**, and check the distance
  readout; wheel farther in/out to confirm the clamps. Drag at both limits.
- With an actual 2-million-star export, use the production preview, let upload
  finish, then watch the live segment count, FPS, draw-call count and resolution.
  Check while orbiting at 1, 1,000 and 20,000 pc. Expect 2,000,000 segments and
  one draw call; record hardware, viewport, and observed FPS when benchmarking.
  Pixel ratio is fixed at 1 and MSAA is off to bound laptop fill cost.

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
