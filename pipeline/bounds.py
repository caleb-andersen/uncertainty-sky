"""Stage 1b - turn the Gaia catalogue into distance bounds.

Each star becomes a line segment along its own line of sight from Earth,
spanning the 1-sigma distance interval implied by its parallax and that
parallax's error. Two numbers per star, never one:

    near_pc = 1000 / (parallax_corrected + parallax_error)
    far_pc  = 1000 / (parallax_corrected - parallax_error)

There is deliberately no distance estimate anywhere in this file. 1/parallax as
a point distance is not computed, not stored, and not used as an intermediate.
The interval *is* the datum.

Run after fetch_gaia.py:
    python bounds.py
    python bounds.py --in data/gaia_raw.parquet --out data/star_bounds.parquet
"""

from __future__ import annotations

import argparse
import json
from datetime import datetime, timezone
from pathlib import Path

import numpy as np
import pandas as pd

# --- Parallax zero point ---------------------------------------------------
# Gaia DR3 parallaxes carry a small global offset: they are systematically too
# small by about 17 microarcseconds. Correcting means *adding* 0.017 mas.
#
# Lindegren et al. 2021 (A&A 649, A4) derives a much fuller correction that
# varies with G magnitude, colour and ecliptic latitude, distributed as the
# `gaiadr3-zeropoint` package. We are deliberately not using it. It would fold a
# fitted model into numbers we present as measured, and this project's whole
# claim is that the geometry on screen is the catalogue and nothing else. One
# published constant, applied uniformly and stated plainly, is the honest
# version of that trade.
ZERO_POINT_MAS = -0.017

# --- Horizon ---------------------------------------------------------------
# When (parallax_corrected - parallax_error) <= 0 the far bound is formally
# infinite: the data are consistent with the star being arbitrarily distant.
# Those stars are the most honest objects in the catalogue and are never
# dropped. Their far end is clamped here purely so the renderer has finite
# geometry to put in a buffer, and the `unbounded` flag says so.
MAX_DISTANCE_PC = 20_000.0

DATA_DIR = Path(__file__).resolve().parent / "data"
DEFAULT_IN = DATA_DIR / "gaia_raw.parquet"
DEFAULT_OUT = DATA_DIR / "star_bounds.parquet"


def unit_vectors(ra_deg: np.ndarray, dec_deg: np.ndarray):
    """ICRS right ascension / declination -> right-handed unit vectors.

    Earth sits at the origin, x points at (ra=0, dec=0), y at (ra=90, dec=0),
    z at the north celestial pole. x cross y = z, so the frame is right-handed
    as the project conventions require.
    """
    ra = np.radians(ra_deg)
    dec = np.radians(dec_deg)
    cos_dec = np.cos(dec)
    return cos_dec * np.cos(ra), cos_dec * np.sin(ra), np.sin(dec)


def compute_bounds(df: pd.DataFrame) -> pd.DataFrame:
    """Catalogue rows -> near/far endpoints in parsecs."""
    required = {"source_id", "ra", "dec", "parallax", "parallax_error"}
    missing = required - set(df.columns)
    if missing:
        raise ValueError(f"input is missing required columns: {sorted(missing)}")

    n_in = len(df)

    # A row without a usable parallax pair has no segment. This should remove
    # nothing - fetch_gaia.py already required parallax > 0, and gaia_source
    # always ships an error alongside a parallax - but a silent NaN here would
    # become silent garbage geometry downstream.
    usable = (
        np.isfinite(df["parallax"])
        & np.isfinite(df["parallax_error"])
        & np.isfinite(df["ra"])
        & np.isfinite(df["dec"])
        & (df["parallax_error"] > 0)
    )
    dropped = n_in - int(usable.sum())
    if dropped:
        print(f"[bounds] dropped {dropped:,} rows with unusable astrometry")
    df = df.loc[usable].reset_index(drop=True)

    parallax = df["parallax"].to_numpy(dtype=np.float64)
    error = df["parallax_error"].to_numpy(dtype=np.float64)

    # Zero point first, before any geometry touches these numbers.
    corrected = parallax - ZERO_POINT_MAS

    upper_parallax = corrected + error  # nearest the star can plausibly be
    lower_parallax = corrected - error  # furthest; may be <= 0

    unbounded = lower_parallax <= 0.0

    near_pc = 1000.0 / upper_parallax

    far_pc = np.empty_like(near_pc)
    np.divide(1000.0, lower_parallax, out=far_pc, where=~unbounded)
    far_pc[unbounded] = np.inf

    # Clamping is a rendering concession, not a measurement, so record exactly
    # which stars it touched. Every unbounded star is clamped; so is the rare
    # star whose lower parallax is positive but tiny enough to put its far end
    # past the horizon.
    far_clamped = far_pc > MAX_DISTANCE_PC
    far_pc = np.minimum(far_pc, MAX_DISTANCE_PC)

    # A star can also sit entirely beyond the horizon: corrected + error is at
    # minimum 0.017 mas, which is a near bound of ~59 kpc. Vanishingly rare
    # (it needs a tiny parallax *and* a tiny error) but it would otherwise
    # produce an inverted segment, so clamp it to a point on the horizon and
    # count it.
    near_clamped = near_pc > MAX_DISTANCE_PC
    near_pc = np.minimum(near_pc, MAX_DISTANCE_PC)

    ux, uy, uz = unit_vectors(
        df["ra"].to_numpy(dtype=np.float64), df["dec"].to_numpy(dtype=np.float64)
    )

    out = pd.DataFrame(
        {
            "source_id": df["source_id"].to_numpy(dtype=np.int64),
            "ra": df["ra"].to_numpy(dtype=np.float64),
            "dec": df["dec"].to_numpy(dtype=np.float64),
            "parallax": parallax,
            "parallax_error": error,
            "parallax_corrected": corrected,
            "near_pc": near_pc.astype(np.float32),
            "far_pc": far_pc.astype(np.float32),
            "length_pc": (far_pc - near_pc).astype(np.float32),
            "unbounded": unbounded,
            "far_clamped": far_clamped,
            # Endpoints in parsecs. float32 resolves ~1e-3 pc at the horizon,
            # far finer than the uncertainty these segments represent, and it
            # halves what stage 2 has to pack.
            "near_x": (ux * near_pc).astype(np.float32),
            "near_y": (uy * near_pc).astype(np.float32),
            "near_z": (uz * near_pc).astype(np.float32),
            "far_x": (ux * far_pc).astype(np.float32),
            "far_y": (uy * far_pc).astype(np.float32),
            "far_z": (uz * far_pc).astype(np.float32),
        }
    )

    for col in ("phot_g_mean_mag", "bp_rp"):
        if col in df.columns:
            out[col] = df[col].to_numpy(dtype=np.float32)

    out.attrs["near_clamped"] = int(near_clamped.sum())
    return out


def summarise(out: pd.DataFrame) -> dict:
    """Print the numbers worth sanity-checking before anything gets rendered."""
    n = len(out)
    length = out["length_pc"].to_numpy(dtype=np.float64)
    unbounded = out["unbounded"].to_numpy()
    clamped = out["far_clamped"].to_numpy()

    p10, p50, p90 = np.percentile(length, [10, 50, 90])
    frac_unbounded = float(unbounded.mean())
    frac_clamped = float(clamped.mean())

    print()
    print("=" * 68)
    print(f"  stars                       {n:,}")
    print(f"  median streak length        {p50:,.1f} pc")
    print(f"  fraction unbounded          {frac_unbounded:.4f}  ({int(unbounded.sum()):,} stars)")
    print(f"  fraction far-clamped        {frac_clamped:.4f}  ({int(clamped.sum()):,} stars)")
    print()
    print("  streak length percentiles (all stars)")
    print(f"    p10                       {p10:,.1f} pc")
    print(f"    p50                       {p50:,.1f} pc")
    print(f"    p90                       {p90:,.1f} pc")

    honest = ~clamped
    stats = {
        "stars": n,
        "median_length_pc": float(p50),
        "fraction_unbounded": frac_unbounded,
        "fraction_far_clamped": frac_clamped,
        "length_pc_p10": float(p10),
        "length_pc_p50": float(p50),
        "length_pc_p90": float(p90),
    }

    if honest.any():
        # The clamp piles a large slug of stars onto exactly 20000 pc, which
        # drags the upper percentiles above. These are the same percentiles
        # over only the stars whose far end is a real measurement.
        h10, h50, h90 = np.percentile(length[honest], [10, 50, 90])
        print()
        print(f"  streak length percentiles (unclamped only, {int(honest.sum()):,} stars)")
        print(f"    p10                       {h10:,.1f} pc")
        print(f"    p50                       {h50:,.1f} pc")
        print(f"    p90                       {h90:,.1f} pc")
        stats.update(
            unclamped_length_pc_p10=float(h10),
            unclamped_length_pc_p50=float(h50),
            unclamped_length_pc_p90=float(h90),
        )

    near = out["near_pc"].to_numpy(dtype=np.float64)
    far = out["far_pc"].to_numpy(dtype=np.float64)
    print()
    print(f"  near_pc   min {near.min():,.2f} / median {np.median(near):,.1f} / max {near.max():,.1f}")
    print(f"  far_pc    min {far.min():,.2f} / median {np.median(far):,.1f} / max {far.max():,.1f}")

    near_clamped = int(out.attrs.get("near_clamped", 0))
    if near_clamped:
        print(f"  [note] {near_clamped:,} stars sit entirely beyond the {MAX_DISTANCE_PC:,.0f} pc horizon")
    stats["near_clamped"] = near_clamped

    inverted = int((far < near).sum())
    if inverted:
        print(f"  [warn] {inverted:,} segments have far < near")
    stats["inverted"] = inverted
    print("=" * 68)
    print()
    return stats


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--in", dest="in_path", type=Path, default=DEFAULT_IN,
                        help="input parquet from fetch_gaia.py")
    parser.add_argument("--out", dest="out_path", type=Path, default=DEFAULT_OUT,
                        help="output parquet of distance bounds")
    args = parser.parse_args(argv)

    if not args.in_path.exists():
        parser.error(f"{args.in_path} not found - run fetch_gaia.py first")

    print(f"[bounds] reading {args.in_path}")
    df = pd.read_parquet(args.in_path)
    print(f"[bounds] {len(df):,} rows in")

    out = compute_bounds(df)
    stats = summarise(out)

    args.out_path.parent.mkdir(parents=True, exist_ok=True)
    out.to_parquet(args.out_path, index=False, compression="zstd")

    meta = {
        "stage": "bounds",
        "built_utc": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "source": str(args.in_path),
        "zero_point_mas": ZERO_POINT_MAS,
        "max_distance_pc": MAX_DISTANCE_PC,
        "frame": "ICRS equatorial, right-handed, Earth at origin, parsecs",
        "stats": stats,
    }
    meta_path = args.out_path.with_suffix(".meta.json")
    meta_path.write_text(json.dumps(meta, indent=2) + "\n", encoding="utf-8")

    print(f"[write] {args.out_path}  ({len(out):,} rows, {args.out_path.stat().st_size / 1e6:.1f} MB)")
    print(f"[write] {meta_path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
