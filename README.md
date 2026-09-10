# Uncertainty Sky

A WebGL visualisation of Gaia DR3 astrometry where every star is drawn as its
distance uncertainty instead of as a point.

## The idea

Every star map ever made draws stars as confident points. Gaia publishes both
`parallax` and `parallax_error` for 1.5 billion stars, and almost everyone
throws the second number away.

This project renders the second number. Each star becomes a line segment along
its own line of sight from Earth, spanning the 1-sigma distance interval implied
by its parallax and that parallax's error:

    near_pc = 1000 / (parallax_corrected + parallax_error)
    far_pc  = 1000 / (parallax_corrected - parallax_error)

Nearby stars stay short. Distant ones stretch into long spears. Flown outward,
the galaxy resolves into a sheaf of needles all aimed back at the observer.

There is no distance estimate anywhere in the pipeline. `1 / parallax` as a point
distance is never computed, never stored, and never used as an intermediate. The
interval is the datum.

## How to read the picture

- **Length is uncertainty.** It is not size and not brightness. A long streak is
  a star whose direction we know and whose distance we do not.
- **Colour** comes from the observed BP-RP colour index, mapped through an
  approximate main-sequence temperature onto a Planckian locus. It is not
  corrected for interstellar reddening, so a reddened hot star reads cool.
- **Stippled streaks** have no colour measurement in the catalogue. They are
  drawn differently so they cannot be mistaken for a measured hue.
- **Streaks that dissolve at the far end** have a far bound that is not a
  measurement. Either it hit the 20,000 pc horizon, or the lower parallax was
  non-positive and the far bound is formally infinite. Those stars are the most
  honest objects in the catalogue and are never dropped.

Everything on screen that is a display decision rather than a measurement says so
in the panel or the legend. Nothing is smoothed, inferred or filled in.

## Running it

The catalogue is not in this repository and will not be. Everything under
`web/public/data` is reproducible from the pipeline, so the repo carries the code
and not the sky.

### 1. Build the data, Python 3.11

```sh
cd pipeline
pip install -r requirements.txt
python fetch_gaia.py --target-rows 50000
python bounds.py
python pack.py
```

Drop the flag on `fetch_gaia.py` for the full pull of roughly 2 million stars.
Start small: a full pull takes a long time to come down from the archive and
packs to about 108 MB.

`fetch_gaia.py` subsamples on Gaia's pre-shuffled `random_index` rather than
cutting on magnitude. A magnitude cut keeps bright stars, bright stars have good
parallaxes, and a sample of good parallaxes has no uncertainty left in it to
show. `bounds.py` turns parallaxes into near and far bounds and applies a single
published zero-point constant. `pack.py` writes five raw little-endian buffers
and a `meta.json` into `web/public/data`.

### 2. Run the renderer, Node 22.12 or newer

```sh
cd web
npm ci
npm run dev
```

A missing catalogue produces an explicit error rather than substitute stars.

Drag to orbit, wheel to dolly, and use the logarithmic slider to cross the whole
1 to 20,000 pc range. Press **F** for the scripted flight, and **Escape** to
return to the controls. [`web/README.md`](web/README.md) covers the shader, the
three treatments, video export, and what has actually been verified on hardware.

## Layout

| Path | What it holds |
| --- | --- |
| `pipeline/` | Gaia fetch, distance bounds, and the packer that writes GPU buffers |
| `web/` | The Three.js renderer, the flight projector, and the video exporter |
| `web/public/data/` | Where packed buffers land. Empty in a fresh clone |
| `NOTICE` | What the MIT grant covers and what it does not |

## The film

`web/src/flight.ts` is the projector. It holds the easing, the spline inversion
that gives every distance decade equal screen time, the subtitle timing and the
checks that reject a malformed score. It contains no waypoint and no line of
narration.

The score is the film itself: where the camera goes, when it cuts, and what the
cards say. It is not committed, because the choreography and the writing are
authored work rather than the code that plays them. A fresh clone gets
`web/src/score.example.ts` copied into place automatically, which is a short
plain flight that keeps the renderer runnable and exercised. Copy it, rewrite it,
and your own flight stays yours.

## Status

The renderer draws every packed segment in one draw call with no per-star
JavaScript in the animation loop. The 60 fps target with the full 2 million stars
has not yet been measured on the target hardware. Development measurements,
including GPU timer queries against a 49,969-star export, are recorded in
`web/README.md`, and a blank scene's frame rate is deliberately not reported.

## Licensing

The source code is MIT, Copyright (c) 2026 Caleb Andersen. See `LICENSE`.

The MIT grant reaches the code and nothing else. Gaia data, rendered video output
and the soundtrack all have different owners or different terms, and `NOTICE`
sets out which is which. Read it before redistributing anything from here that is
not source.

Work published using Gaia data carries ESA's standard acknowledgement, quoted in
`NOTICE`. Check it against ESA's current credit page before you publish.
