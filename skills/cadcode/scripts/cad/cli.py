"""``python scripts/cad <input.py | project_dir/> [--out-dir DIR]`` — primary tool.

Hands the user's project off to ``cadpy.generation.generate_step`` inside a
sandboxed subprocess. cadpy reads ``main.py``, calls ``gen_step()`` (or the
legacy ``result = …`` form), and writes the full Panda artifact set next to
``output_path``:

  <stem>.step  <stem>.glb  <stem>.topology.json  <stem>.step.json
  <stem>.stl   (only if envelope `stl=True`)
  <stem>.3mf   (only if envelope `3mf=True`)

Prints a single JSON line on stdout matching contract §3 ``CadcodeResult``.
"""

from __future__ import annotations

import argparse
import json
import shutil
import sys
import tempfile
from collections.abc import Sequence
from pathlib import Path

SCRIPTS_DIR = Path(__file__).resolve().parents[1]
if str(SCRIPTS_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPTS_DIR))

from common.runner import run_sandboxed_sync


def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(
        prog="scripts/cad",
        description=(
            "Compile a CadQuery project (or single .py) into STEP + GLB + "
            "topology + metadata (+ optional STL/3MF) via the cadpy "
            "artifact pipeline."
        ),
    )
    p.add_argument(
        "input",
        type=Path,
        help=(
            "Path to a CadQuery .py file (defines ``gen_step()`` or the "
            "legacy ``result = <shape>``), OR a project directory "
            "containing a main.py. In project mode, sibling modules and "
            "packages (params.py, parts/, features/, etc.) are added to "
            "sys.path so main.py can import them."
        ),
    )
    p.add_argument(
        "--out-dir",
        type=Path,
        default=None,
        help="Where to write artifacts (default: same directory as input).",
    )
    p.add_argument(
        "--stem",
        default=None,
        help="Override the output filename stem (default: input file's stem).",
    )
    p.add_argument(
        "--wall-clock-s",
        type=float,
        default=30.0,
        help="Wall-clock timeout for the worker subprocess (seconds).",
    )
    p.add_argument(
        "--mesh-tolerance",
        type=float,
        default=0.05,
        help=(
            "Linear meshing tolerance for the STL/GLB (mm). Default 0.05 "
            "gives smooth small-radius features (screw holes, countersinks). "
            "Drop to 0.02 for very fine detail; raise to 0.1 for fast drafts."
        ),
    )
    p.add_argument(
        "--angular-tolerance",
        type=float,
        default=3.0,
        help="Angular meshing tolerance for the STL/GLB (degrees). Default 3.0.",
    )
    return p


def _resolve_project_and_stem(
    input_path: Path,
    stem_override: str | None,
) -> tuple[Path, str, Path | None]:
    """Normalize input → (project_dir, stem, scratch_to_cleanup).

    cadpy's entry point expects a directory containing ``main.py``. A
    user-supplied single ``.py`` file is copied into a scratch directory
    as ``main.py``; the caller MUST remove ``scratch_to_cleanup`` after
    the run.

    Returns ``scratch_to_cleanup=None`` for project-mode inputs.
    """
    if input_path.is_dir():
        main_py = input_path / "main.py"
        if not main_py.exists():
            return input_path, "", None  # caller will surface the error
        stem = stem_override or input_path.name
        return input_path, stem, None

    # Single-file mode: synthesize a temp project dir containing only the
    # user's file copied to main.py. We preserve the original file's stem
    # for output naming, but cadpy reads the file as ``main.py``.
    scratch = Path(tempfile.mkdtemp(prefix="cadcode-single-"))
    shutil.copy2(input_path, scratch / "main.py")
    stem = stem_override or input_path.stem
    return scratch, stem, scratch


def main(argv: Sequence[str] | None = None) -> int:
    args = build_parser().parse_args(list(argv) if argv is not None else None)

    input_path = args.input
    if not input_path.exists():
        print(json.dumps({
            "ok": False,
            "error": {
                "code": "VALIDATION_FAILED",
                "message": f"input not found: {input_path}",
            },
        }))
        return 2

    # Project-mode missing main.py is a structural error — fail fast.
    if input_path.is_dir() and not (input_path / "main.py").exists():
        print(json.dumps({
            "ok": False,
            "error": {
                "code": "VALIDATION_FAILED",
                "message": (
                    f"project directory {input_path} has no main.py — "
                    "create one that defines gen_step() or assigns `result`"
                ),
            },
        }))
        return 2

    project_dir, stem, scratch = _resolve_project_and_stem(
        input_path.resolve(),
        args.stem,
    )
    out_dir = args.out_dir or (
        input_path.parent if input_path.is_file() else input_path
    )

    try:
        payload = run_sandboxed_sync(
            project_dir=project_dir,
            out_dir=out_dir.resolve(),
            stem=stem,
            wall_clock_s=args.wall_clock_s,
            mesh_tolerance=args.mesh_tolerance,
            angular_tolerance=args.angular_tolerance,
        )
    finally:
        if scratch is not None:
            shutil.rmtree(scratch, ignore_errors=True)

    print(json.dumps(payload))
    return 0 if payload.get("ok") else 1


if __name__ == "__main__":
    raise SystemExit(main())
