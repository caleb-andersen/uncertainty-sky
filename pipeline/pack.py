"""Stage 2 - serialise star bounds into GPU-ready binary buffers.

Reads the parquet from bounds.py and writes one raw little-endian buffer per
vertex attribute into /web/public/data/, so the loader can fetch them in
parallel and hand each one straight to a THREE.BufferAttribute with no parsing
and no per-star JavaScript.

Vertex layout - two vertices per star, adjacent, in this order:

    vertex 2i      near endpoint of star i
    vertex 2i + 1  far  endpoint of star i

which is exactly what THREE.LineSegments consumes: consecutive pairs form one
segment. The per-star scalars (colour, brightness, flag) are duplicated across
both vertices of a star, because a BufferAttribute is indexed per vertex and
there is nowhere else to put them.

Files written:

    position.bin    float32 x 3   near endpoint, then far endpoint
    midpoint.bin    float32 x 3   the segment's centre, same value on both
                                  vertices - the "confident point" state
    color.bin       uint8  x 1    quantised bp_rp, 0 = not measured
    brightness.bin  uint8  x 1    quantised phot_g_mean_mag, 0 = not measured
    unbounded.bin   uint8  x 1    0 measured / 1 clamped / 2 formally infinite
    meta.json       counts, byte offsets, dtypes, decode rules, bounding radius

Run after bounds.py:
    python pack.py
    python pack.py --in data/star_bounds.parquet --out ../web/public/data
    python pack.py --limit 50000        # small buffers for development
"""

from __future__ import annotations

import argparse
import json
from datetime import datetime, timezone
from pathlib import Path

import numpy as np
import pandas as pd
import pyarrow.parquet as pq

# --- Quantisation domains --------------------------------------------------
# Both photometric channels are squeezed into a single byte. The domains below
# are fixed constants rather than the min/max of whatever pull happens to be on
# disk, for one reason: a data-derived range silently rescales the colour map
# every time the catalogue is re-sampled, so two builds of this project would
# render the same star in two different colours. A fixed domain means the
# renderer can hard-code a legend and the mapping means the same thing forever.
#
# The cost is that genuine outliers clamp. summarise() prints exactly how many
# did, at both ends, so a domain that is wrong for a given pull is visible
# rather than quiet.
#
# bp_rp is the Gaia BP-RP colour index. The bluest main-sequence stars sit near
# -0.4; heavily reddened and very cool sources run past 5.
BP_RP_DOMAIN = (-0.5, 5.5)

# phot_g_mean_mag: Gaia's G band spans roughly 1.7 (the handful of naked-eye
# brightest) down to the ~21 mag survey limit.
G_MAG_DOMAIN = (2.0, 22.0)

# --- The missing-measurement sentinel --------------------------------------
# phot_g_mean_mag and bp_rp are genuinely absent for a slice of gaia_source,
# and fetch_gaia.py deliberately carries those through as NaN rather than
# imputing them. That has to survive quantisation too, so code 0 is reserved to
# mean "this star has no measurement in this band" and real values occupy
# 1..255. The renderer is expected to draw a 0 as visibly unmeasured. Handing
# it a plausible mid-grey instead would be exactly the kind of invented number
# this project exists to avoid.
SENTINEL = 0
LEVELS = 255  # codes 1..255 inclusive

# --- Unbounded flag codes --------------------------------------------------
# bounds.py distinguishes two different reasons a far endpoint might not be a
# measurement, and collapsing them into one boolean would throw away the more
# interesting half. Kept apart here; it is the same byte either way.
FLAG_MEASURED = 0   # far end is 1000 / (parallax - error), a real number
FLAG_CLAMPED = 1    # positive lower parallax, but far end past the horizon
FLAG_UNBOUNDED = 2  # lower parallax <= 0: the far end is formally infinite

PIPELINE_DIR = Path(__file__).resolve().parent
DEFAULT_IN = PIPELINE_DIR / "data" / "star_bounds.parquet"
DEFAULT_OUT = PIPELINE_DIR.parent / "web" / "public" / "data"

# Columns pack.py actually needs. Named explicitly so a 2M-row parquet does not
# drag its float64 astrometry columns through memory for no reason.
NEEDED = [
    "near_x", "near_y", "near_z",
    "far_x", "far_y", "far_z",
    "unbounded", "far_clamped",
]
# bounds.py only emits these when fetch_gaia.py supplied them.
OPTIONAL = ["bp_rp", "phot_g_mean_mag"]


def quantise(values: np.ndarray, domain: tuple[float, float], invert: bool):
    """Map a float channel onto codes 1..255, reserving 0 for "not measured".

    Linear across `domain`, clamped at both ends. `invert` flips the direction
    so that a magnitude (where smaller means brighter) comes out as a
    brightness (where larger means brighter).

    Returns (codes, n_clamped_low, n_clamped_high, n_missing). The mapping is
    exactly invertible - meta.json carries the formula - so nothing here is a
    one-way perceptual curve. Any such curve belongs in the shader, where it
    can be changed without rebuilding the data.
    """
    lo, hi = domain
    finite = np.isfinite(values)

    below = int(np.count_nonzero(finite & (values < lo)))
    above = int(np.count_nonzero(finite & (values > hi)))
    missing = int(np.count_nonzero(~finite))

    # NaN would propagate through the arithmetic and cast to garbage, so park
    # the missing entries at `lo` for the ride and overwrite them at the end.
    safe = np.where(finite, values, lo).astype(np.float64)
    t = (np.clip(safe, lo, hi) - lo) / (hi - lo)
    if invert:
        t = 1.0 - t

    codes = (np.rint(t * (LEVELS - 1)) + 1).astype(np.uint8)
    codes[~finite] = SENTINEL
    return codes, below, above, missing


def build_flags(df: pd.DataFrame) -> np.ndarray:
    """Per-star far-endpoint provenance, as one of the FLAG_* codes."""
    unbounded = df["unbounded"].to_numpy(dtype=bool)
    clamped = df["far_clamped"].to_numpy(dtype=bool)

    flags = np.full(len(df), FLAG_MEASURED, dtype=np.uint8)
    # far_clamped is a superset of unbounded, so write the weaker claim first
    # and let the stronger one overwrite it.
    flags[clamped] = FLAG_CLAMPED
    flags[unbounded] = FLAG_UNBOUNDED
    return flags


def duplicate(per_star: np.ndarray) -> np.ndarray:
    """Per-star scalar -> per-vertex, same value on a star's two vertices."""
    return np.repeat(per_star, 2)


def build_positions(df: pd.DataFrame):
    """Endpoint and midpoint buffers, both (n_stars * 2 * 3,) float32.

    The midpoint is the centre of the segment actually being drawn, taken from
    the same endpoints that go into position.bin. It is a rendering waypoint -
    the collapsed "confident point" the view morphs away from - and not a
    distance estimate; nothing downstream should read it as one.
    """
    n = len(df)

    near = np.stack(
        [df[c].to_numpy(dtype=np.float32) for c in ("near_x", "near_y", "near_z")],
        axis=1,
    )
    far = np.stack(
        [df[c].to_numpy(dtype=np.float32) for c in ("far_x", "far_y", "far_z")],
        axis=1,
    )

    if not (np.isfinite(near).all() and np.isfinite(far).all()):
        raise ValueError(
            "non-finite endpoint coordinates in the input - bounds.py should "
            "have clamped every infinity before writing the parquet"
        )

    positions = np.empty((n, 2, 3), dtype=np.float32)
    positions[:, 0, :] = near
    positions[:, 1, :] = far

    # float64 for the halving, so the midpoint is the true centre of the two
    # float32 endpoints rather than a doubly-rounded one.
    mid = ((near.astype(np.float64) + far.astype(np.float64)) * 0.5).astype(np.float32)
    midpoints = np.empty((n, 2, 3), dtype=np.float32)
    midpoints[:, 0, :] = mid
    midpoints[:, 1, :] = mid

    return positions.reshape(-1), midpoints.reshape(-1)


def bounding_radius(positions: np.ndarray) -> float:
    """Largest distance from the origin to any packed vertex, in parsecs.

    Computed from the packed float32 values rather than from far_pc, so it
    describes the geometry the renderer will actually receive.
    """
    xyz = positions.reshape(-1, 3).astype(np.float64)
    return float(np.sqrt((xyz * xyz).sum(axis=1)).max())


def write_buffer(path: Path, array: np.ndarray, dtype: str, item_size: int) -> dict:
    """Write one attribute as a raw little-endian buffer, return its meta."""
    packed = np.ascontiguousarray(array, dtype=np.dtype(dtype))
    path.write_bytes(packed.tobytes())
    return {
        "file": path.name,
        "byte_offset": 0,  # one file per attribute, so each starts at zero
        "byte_length": int(packed.nbytes),
        "dtype": dtype,
        "bytes_per_component": packed.dtype.itemsize,
        "item_size": item_size,
        "count": int(packed.size // item_size),
        "normalized": False,
    }


def summarise(n, colour_stats, bright_stats, flags, radius) -> dict:
    """Print the numbers worth checking before any of this reaches a GPU."""
    c_below, c_above, c_missing = colour_stats
    b_below, b_above, b_missing = bright_stats

    n_measured = int(np.count_nonzero(flags == FLAG_MEASURED))
    n_clamped = int(np.count_nonzero(flags == FLAG_CLAMPED))
    n_unbounded = int(np.count_nonzero(flags == FLAG_UNBOUNDED))

    print()
    print("=" * 68)
    print(f"  stars                       {n:,}")
    print(f"  vertices                    {n * 2:,}")
    print(f"  bounding radius             {radius:,.1f} pc")
    print()
    print("  far endpoint provenance")
    print(f"    measured                  {n_measured:,}  ({n_measured / n:.4f})")
    print(f"    clamped at horizon        {n_clamped:,}  ({n_clamped / n:.4f})")
    print(f"    formally unbounded        {n_unbounded:,}  ({n_unbounded / n:.4f})")
    print()
    print(f"  colour   bp_rp {BP_RP_DOMAIN[0]:+.2f} .. {BP_RP_DOMAIN[1]:+.2f}")
    print(f"    not measured (code 0)     {c_missing:,}  ({c_missing / n:.4f})")
    print(f"    clamped low / high        {c_below:,} / {c_above:,}")
    print(f"  bright   G     {G_MAG_DOMAIN[0]:.2f} .. {G_MAG_DOMAIN[1]:.2f}  (inverted)")
    print(f"    not measured (code 0)     {b_missing:,}  ({b_missing / n:.4f})")
    print(f"    clamped bright / faint    {b_below:,} / {b_above:,}")

    for label, low, high in (
        ("bp_rp", c_below, c_above),
        ("phot_g_mean_mag", b_below, b_above),
    ):
        if (low + high) / n > 0.01:
            print(f"  [warn] >1% of {label} clamped - the fixed domain may be "
                  "wrong for this pull")
    print("=" * 68)
    print()

    return {
        "stars": n,
        "vertices": n * 2,
        "bounding_radius_pc": radius,
        "far_measured": n_measured,
        "far_clamped": n_clamped,
        "far_unbounded": n_unbounded,
        "bp_rp_missing": c_missing,
        "bp_rp_clamped_low": c_below,
        "bp_rp_clamped_high": c_above,
        "phot_g_missing": b_missing,
        "phot_g_clamped_bright": b_below,
        "phot_g_clamped_faint": b_above,
    }


def pack(df: pd.DataFrame, out_dir: Path, source: Path) -> dict:
    """Quantise, serialise, and write the buffers plus meta.json."""
    missing = set(NEEDED) - set(df.columns)
    if missing:
        raise ValueError(f"input is missing required columns: {sorted(missing)}")

    n = len(df)
    if n == 0:
        raise ValueError("input has no rows")

    out_dir.mkdir(parents=True, exist_ok=True)

    positions, midpoints = build_positions(df)
    radius = bounding_radius(positions)

    # A column fetch_gaia.py never pulled is not the same thing as a column of
    # NaN, but it packs identically: every star reads as "not measured".
    def channel(name):
        if name in df.columns:
            return df[name].to_numpy(dtype=np.float64)
        print(f"[pack] {name} absent from input - packing all-sentinel")
        return np.full(n, np.nan)

    colour, c_lo, c_hi, c_miss = quantise(
        channel("bp_rp"), BP_RP_DOMAIN, invert=False)
    bright, b_lo, b_hi, b_miss = quantise(
        channel("phot_g_mean_mag"), G_MAG_DOMAIN, invert=True)
    flags = build_flags(df)

    attributes = {
        "position": write_buffer(
            out_dir / "position.bin", positions, "<f4", 3),
        "midpoint": write_buffer(
            out_dir / "midpoint.bin", midpoints, "<f4", 3),
        "color": write_buffer(
            out_dir / "color.bin", duplicate(colour), "<u1", 1),
        "brightness": write_buffer(
            out_dir / "brightness.bin", duplicate(bright), "<u1", 1),
        "unbounded": write_buffer(
            out_dir / "unbounded.bin", duplicate(flags), "<u1", 1),
    }

    stats = summarise(
        n, (c_lo, c_hi, c_miss), (b_lo, b_hi, b_miss), flags, radius)

    lo, hi = BP_RP_DOMAIN
    glo, ghi = G_MAG_DOMAIN
    meta = {
        "stage": "pack",
        "built_utc": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "source": str(source),
        "frame": "ICRS equatorial, right-handed, Earth at origin, parsecs",
        "byte_order": "little-endian",
        "stars": n,
        "vertices": n * 2,
        "bounding_radius_pc": radius,
        "vertex_layout": (
            "two vertices per star: 2i is the near endpoint, 2i+1 the far "
            "endpoint. Per-star scalars are duplicated across both. Draw as "
            "THREE.LineSegments."
        ),
        "attributes": attributes,
        "decode": {
            "color": {
                "source_column": "bp_rp",
                "sentinel": SENTINEL,
                "sentinel_means": "no bp_rp measurement for this star",
                "domain": [lo, hi],
                "formula": f"bp_rp = {lo} + (code - 1) / {LEVELS - 1} * {hi - lo}",
                "clamped": True,
            },
            "brightness": {
                "source_column": "phot_g_mean_mag",
                "sentinel": SENTINEL,
                "sentinel_means": "no phot_g_mean_mag measurement for this star",
                "domain": [glo, ghi],
                "inverted": True,
                "formula": (
                    f"phot_g_mean_mag = {ghi} - (code - 1) / {LEVELS - 1} "
                    f"* {ghi - glo}"
                ),
                "note": (
                    "linear in magnitude, not in flux. Any perceptual or "
                    "logarithmic response belongs in the shader."
                ),
                "clamped": True,
            },
            "unbounded": {
                "source_columns": ["unbounded", "far_clamped"],
                "codes": {
                    str(FLAG_MEASURED): "far endpoint is a measurement",
                    str(FLAG_CLAMPED): (
                        "far endpoint clamped to the horizon; lower parallax "
                        "positive but tiny"
                    ),
                    str(FLAG_UNBOUNDED): (
                        "lower parallax <= 0; far endpoint formally infinite "
                        "and clamped for rendering only"
                    ),
                },
            },
            "midpoint": {
                "note": (
                    "centre of each segment, duplicated across both vertices. "
                    "A rendering waypoint for the collapse-to-point morph, not "
                    "a distance estimate."
                )
            },
        },
        "stats": stats,
    }
    (out_dir / "meta.json").write_text(
        json.dumps(meta, indent=2) + "\n", encoding="utf-8")

    return meta


def report_size(out_dir: Path, meta: dict) -> int:
    """Print each buffer's size on disk and the total. Returns total bytes."""
    names = [a["file"] for a in meta["attributes"].values()] + ["meta.json"]
    total = 0
    print("  output")
    for name in names:
        size = (out_dir / name).stat().st_size
        total += size
        print(f"    {name:<16} {size / 1e6:9.2f} MB")
    print(f"    {'TOTAL':<16} {total / 1e6:9.2f} MB"
          f"   ({total:,} bytes, {total / meta['stars']:.1f} bytes/star)")
    print()
    return total


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--in", dest="in_path", type=Path, default=DEFAULT_IN,
                        help="input parquet from bounds.py")
    parser.add_argument("--out", dest="out_dir", type=Path, default=DEFAULT_OUT,
                        help="output directory for the binary buffers")
    parser.add_argument("--limit", type=int, default=None,
                        help="pack only the first N stars (development)")
    args = parser.parse_args(argv)

    if not args.in_path.exists():
        parser.error(f"{args.in_path} not found - run bounds.py first")

    print(f"[pack] reading {args.in_path}")
    present = set(pq.ParquetFile(args.in_path).schema_arrow.names)
    df = pd.read_parquet(
        args.in_path, columns=NEEDED + [c for c in OPTIONAL if c in present])
    print(f"[pack] {len(df):,} stars in")

    if args.limit is not None:
        df = df.head(args.limit).reset_index(drop=True)
        print(f"[pack] limited to {len(df):,} stars")

    meta = pack(df, args.out_dir, args.in_path)
    report_size(args.out_dir, meta)
    print(f"[write] {args.out_dir}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
