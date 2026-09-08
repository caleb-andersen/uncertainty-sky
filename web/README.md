# Renderer scaffold

From `web`, run `npm ci`, then `npm run dev`. `npm run build` type-checks and
builds the production bundle; `npm run preview` serves that bundle locally.
Node 22.12+ is required by the build tooling.

The catalogue is not included. Run the existing pipeline through `pack.py` to
populate `public/data/meta.json` and its five `.bin` files. Missing data produces
an explicit error, with no substitute stars. The loader validates the packer
layout, fetches all five attributes concurrently, and streams directly into
preallocated buffers (108 MB total for 2 million stars). It retains raw scalar
codes and their zero sentinels for the next shader stage.

One non-indexed `BufferGeometry` and one `LineSegments` object draw every packed
pair, with no sampling or per-star work in the animation loop. Only `position`
is consumed by the current unlit `LineBasicMaterial`; `midpoint`, `color`,
`brightness`, and `unbounded` are attached for the shader handoff. The scalar
`color` attribute is not RGB: leave `vertexColors` disabled until replacing the
material. Display intensity is uniform, not a photometric measurement. Capped
and unbounded endpoints remain explicitly disclosed on screen until the shader
can distinguish their provenance.

The camera orbits Earth in right-handed ICRS coordinates (+Z north). Panning is
disabled so OrbitControls' 1–20,000 pc radius limits are distances from Earth.
Use drag to orbit, wheel/pinch to dolly, or the logarithmic slider to cross the
whole range. The two buttons jump to exact limits. The renderer requests a
logarithmic depth buffer with a 0.01 pc near plane; the far plane encloses the
catalogue even when the camera is at 20,000 pc. See the
[Three.js renderer documentation](https://threejs.org/docs/pages/WebGLRenderer.html)
for the depth-buffer performance tradeoff.

## Verification

- `npm run build`: strict TypeScript check and production build.
- `npm test`: stream layout, parallel download/progress, truncation and missing
  manifest checks. Byte fixtures are isolated tests, never displayed as stars.
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
