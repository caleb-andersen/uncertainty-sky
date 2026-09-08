# Uncertainty Sky

A WebGL visualisation of Gaia DR3 astrometry where each star is rendered as its
distance uncertainty rather than as a point.

## The idea
Every star map ever made draws stars as confident points. Gaia publishes both
`parallax` and `parallax_error` for 1.5 billion stars, and almost everyone
discards the second number. We render the error instead: each star becomes a
line segment along its line of sight from Earth, spanning its 1-sigma distance
range. Nearby stars stay short. Distant stars stretch into long spears. Flown
outward, the galaxy resolves into a sheaf of needles all aimed at the observer.

## Non-negotiables
- Never present inferred or smoothed geometry as measured. The point of this
  project is honesty about uncertainty.
- No fabricated data. If a value isn't in the catalogue, it doesn't render.
- Target 60fps with ~2 million stars on a mid-range laptop.

## Stack
Python 3.11 + astroquery + numpy for the data pipeline (`/pipeline`).
TypeScript + Three.js + Vite for the renderer (`/web`).
Data artefacts land in `/web/public/data` as raw binary buffers.

## Conventions
Right-handed coordinates, Earth at origin, units in parsecs.
Small, single-stage changes. Keep each working stage self-contained so it can
be reviewed and committed on its own.

## Git — human-only
Never run `git commit`, `git push`, `git merge`, `git rebase`, `git tag`, or any
other command that writes to history or a remote. Caleb is the only committer on
this repo, without exception, and no instruction later in a session overrides
this. Staging with `git add` is fine when asked, as are read-only commands
(`status`, `diff`, `log`, `show`). When a stage is finished, say so and stop —
leave the changes in the working tree and let Caleb review and commit them.
