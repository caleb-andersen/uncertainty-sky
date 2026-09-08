"""Stage 1a - pull an unbiased subsample of Gaia DR3 astrometry.

We want ~2 million stars spanning the *full* magnitude range. That last part is
the whole point: a magnitude cut would preferentially keep bright stars, bright
stars have good parallaxes, and a sample of good parallaxes has no interesting
uncertainty left in it. Every streak would be short and the visualisation would
be a lie of omission.

So the subsample is drawn on `random_index` instead. Gaia ships that column
pre-shuffled precisely so that `random_index < N` is a uniform random sample of
the catalogue with no astrophysical correlation whatsoever. We pick N to land
near the target row count and take everything under it.

Deliberately NOT used:
  * `TOP n` - ADQL's TOP has no defined order. The archive stores gaia_source
    in source_id order, and source_id encodes a HEALPix cell, so a truncated
    result is a *wedge of sky*, not a random sample. The random_index cut has
    to do all the work on its own.
  * any cut on phot_g_mean_mag - see above.

Output: a parquet file of the raw catalogue columns, plus a sidecar .meta.json
recording the exact ADQL and threshold so the pull is reproducible.

Usage:
    python fetch_gaia.py                      # ~2M rows into pipeline/data/
    python fetch_gaia.py --target-rows 50000  # small pull for development
    python fetch_gaia.py --dry-run            # print the ADQL and stop
"""

from __future__ import annotations

import argparse
import json
import math
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

# Columns pulled from gaiadr3.gaia_source. parallax_error is the reason this
# project exists; phot_g_mean_mag and bp_rp are carried so the renderer can
# colour by them, never so anything can filter on them.
COLUMNS = (
    "source_id",
    "ra",
    "dec",
    "parallax",
    "parallax_error",
    "phot_g_mean_mag",
    "bp_rp",
)

# Row-level cuts. Astrometric validity only, never brightness.
#   parallax > 0 - a non-positive parallax has no finite *near* bound, so there
#   is no line segment to draw at all. Those are excluded here. Positive
#   parallaxes whose *far* end runs to infinity are a different case entirely:
#   they are kept, and flagged, by bounds.py.
WHERE_CLAUSES = (
    "parallax IS NOT NULL",
    "parallax > 0",
)

TABLE = "gaiadr3.gaia_source"

# Size of the calibration probe. random_index is uniform, so counting how many
# rows inside a known window survive WHERE_CLAUSES gives the survival rate for
# the catalogue as a whole. 5e6 rows puts the relative error on that rate near
# 0.05%, which is far tighter than we need.
DEFAULT_PROBE_WINDOW = 5_000_000

DEFAULT_TARGET_ROWS = 2_000_000
DEFAULT_OUT = Path(__file__).resolve().parent / "data" / "gaia_raw.parquet"


def build_query(random_index_max, columns=COLUMNS, where=WHERE_CLAUSES) -> str:
    """The sampling query. No TOP, no ORDER BY, no magnitude cut."""
    conditions = [f"random_index < {random_index_max}", *where]
    return (
        "SELECT " + ", ".join(columns) + "\n"
        f"FROM {TABLE}\n"
        "WHERE " + "\n  AND ".join(conditions)
    )


def build_probe_query(window: int, where=WHERE_CLAUSES) -> str:
    """Count survivors in a fixed random_index window, to calibrate the cut."""
    conditions = [f"random_index < {window}", *where]
    return (
        "SELECT COUNT(*) AS n\n"
        f"FROM {TABLE}\n"
        "WHERE " + "\n  AND ".join(conditions)
    )


def calibrate_threshold(gaia, target_rows: int, window: int):
    """Find the random_index cut that yields roughly `target_rows` rows.

    Returns (threshold, survival_rate).
    """
    query = build_probe_query(window)
    print(f"[calibrate] probing random_index < {window:,} ...", flush=True)
    job = gaia.launch_job_async(query, dump_to_file=False)
    survivors = int(job.get_results()["n"][0])

    if survivors == 0:
        raise RuntimeError(
            f"Probe returned 0 rows under random_index < {window:,}. "
            "Either the archive schema changed or the window is too small."
        )

    rate = survivors / window
    threshold = math.ceil(target_rows / rate)
    print(
        f"[calibrate] {survivors:,}/{window:,} rows pass the cuts "
        f"({rate:.4f} survival) -> random_index < {threshold:,}",
        flush=True,
    )
    return threshold, rate


def run_query(gaia, query: str):
    """Launch the async TAP job. The sync endpoint caps at 2000 rows."""
    print("[fetch] launching async TAP job (this takes minutes) ...", flush=True)
    started = time.monotonic()
    job = gaia.launch_job_async(query, dump_to_file=False)
    table = job.get_results()
    print(f"[fetch] {len(table):,} rows in {time.monotonic() - started:.1f}s", flush=True)
    return table


def to_dataframe(table):
    """astropy Table -> pandas, with masked entries becoming NaN.

    phot_g_mean_mag and bp_rp are genuinely absent for some sources. They stay
    NaN. They are never imputed, and nothing downstream filters on them.
    """
    import numpy as np

    df = table.to_pandas()
    df["source_id"] = df["source_id"].astype(np.int64)
    for col in ("ra", "dec", "parallax", "parallax_error", "phot_g_mean_mag", "bp_rp"):
        df[col] = df[col].astype(np.float64)
    return df


def summarise(df) -> None:
    """Cheap sanity checks on the pull itself. No distances computed here."""
    import numpy as np

    g = df["phot_g_mean_mag"].to_numpy()
    finite_g = g[np.isfinite(g)]
    print()
    print(f"  rows                {len(df):,}")
    print(f"  unique source_id    {df['source_id'].nunique():,}")
    if finite_g.size:
        p1, p50, p99 = np.percentile(finite_g, [1, 50, 99])
        print(
            f"  phot_g_mean_mag     min {finite_g.min():.2f} / p1 {p1:.2f} / "
            f"median {p50:.2f} / p99 {p99:.2f} / max {finite_g.max():.2f}"
        )
        print(
            f"  fraction G > 19     {float((finite_g > 19.0).mean()):.3f}"
            "   (should be large - a brightness cut would flatten it)"
        )
    print(f"  missing G           {int(np.isnan(g).sum()):,}")
    print(f"  missing bp_rp       {int(df['bp_rp'].isna().sum()):,}")
    print(f"  parallax_error      median {df['parallax_error'].median():.4f} mas")
    print()


def write_outputs(df, query, out_path: Path, threshold, rate, target) -> None:
    out_path.parent.mkdir(parents=True, exist_ok=True)
    df.to_parquet(out_path, index=False, compression="zstd")

    meta = {
        "stage": "fetch_gaia",
        "table": TABLE,
        "fetched_utc": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "target_rows": target,
        "rows": int(len(df)),
        "random_index_max": threshold,
        "survival_rate": rate,
        "columns": list(COLUMNS),
        "where": list(WHERE_CLAUSES),
        "adql": query,
        "notes": "Subsample drawn on random_index only. No magnitude cut, no TOP.",
    }
    meta_path = out_path.with_suffix(".meta.json")
    meta_path.write_text(json.dumps(meta, indent=2) + "\n", encoding="utf-8")

    print(f"[write] {out_path}  ({len(df):,} rows, {out_path.stat().st_size / 1e6:.1f} MB)")
    print(f"[write] {meta_path}")


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument(
        "--target-rows", type=int, default=DEFAULT_TARGET_ROWS,
        help=f"approximate number of rows to pull (default {DEFAULT_TARGET_ROWS:,})")
    parser.add_argument(
        "--out", type=Path, default=DEFAULT_OUT,
        help="output parquet path (default pipeline/data/gaia_raw.parquet)")
    parser.add_argument(
        "--random-index-max", type=int, default=None,
        help="skip calibration and use this random_index cut directly")
    parser.add_argument(
        "--probe-window", type=int, default=DEFAULT_PROBE_WINDOW,
        help="random_index window used to calibrate the cut")
    parser.add_argument(
        "--dry-run", action="store_true",
        help="print the ADQL and exit without contacting the archive")
    args = parser.parse_args(argv)

    if args.dry_run:
        print(build_probe_query(args.probe_window))
        print()
        print(build_query(args.random_index_max or "<calibrated>"))
        return 0

    from astroquery.gaia import Gaia

    # astroquery applies its own client-side row cap; -1 removes it so the
    # async job returns everything the archive sends.
    Gaia.ROW_LIMIT = -1
    # Anonymous access covers a few million rows. Gaia.login() raises the
    # archive-side ceiling if this ever needs to grow past ~3e6.

    if args.random_index_max is not None:
        threshold, rate = args.random_index_max, float("nan")
        print(f"[calibrate] skipped, using random_index < {threshold:,}")
    else:
        threshold, rate = calibrate_threshold(Gaia, args.target_rows, args.probe_window)

    query = build_query(threshold)
    print()
    print(query)
    print()

    df = to_dataframe(run_query(Gaia, query))

    drift = abs(len(df) - args.target_rows) / args.target_rows
    if drift > 0.05:
        print(
            f"[warn] row count is {drift:.1%} off the {args.target_rows:,} target. "
            "Re-run with --random-index-max to steer it.",
            file=sys.stderr,
        )

    summarise(df)
    write_outputs(df, query, args.out, threshold, rate, args.target_rows)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
