"""``python scripts/review <project_dir | .step | .step.json>`` — QA review pass.

Renders the assembled model and every named part to multi-view PNGs (the
missing per-part visual the build loop needs to actually *look* at), and
re-surfaces the deterministic geometry warnings cadpy recorded in the
``.step.json`` sidecar.

Prints a single JSON line on stdout::

  {
    "ok": true,
    "stem": "ladybug_robot",
    "warnings": [ { "part", "kind", "detail", "severity" }, ... ],
    "assembled_png": "<abs path>",          // may be null if render failed
    "renders": [ { "part", "stl_path", "png_path" }, ... ],
    "section_png": "<abs path>",            // first cross-section, back-compat
    "section_pngs": [ { "axis", "part", "png_path" }, ... ]
  }

Each per-part PNG is a grid of the part seen from every direction (a 3/4 iso plus
all six axis-aligned faces), so a defect that hides behind the body on one view
shows on another.

By default the assembly is cut through its x, y, and z center planes so INTERIOR
engagement always reads — a peg seated in a socket, a tooth on solid material, a
lip inside its groove — which exterior views hide. Pass ``--section
<x|y|z>[@offset]`` (optionally ``--part <name>``) to target a single plane (e.g.
to hit an interface the center cuts miss), or ``--no-sections`` to skip them.

The PNGs are QA artifacts (the viewer renders the STL); they land in
``<stem>_review/`` next to the model. Rendering never raises — a failed render
yields a null path, not an error.
"""

from __future__ import annotations

import argparse
import json
import sys
from collections.abc import Sequence
from pathlib import Path

SCRIPTS_DIR = Path(__file__).resolve().parents[1]
for _p in (SCRIPTS_DIR, SCRIPTS_DIR / "packages"):
    if str(_p) not in sys.path:
        sys.path.insert(0, str(_p))


def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(
        prog="scripts/review",
        description=(
            "Render the assembled model + each named part to QA PNGs and "
            "re-surface cadpy's deterministic geometry warnings."
        ),
    )
    p.add_argument(
        "input",
        type=Path,
        help=(
            "A generated project dir (containing <stem>.step.json), or a path "
            "to a .step / .step.json file directly."
        ),
    )
    p.add_argument(
        "--stem",
        default=None,
        help="Disambiguate when a directory holds multiple .step.json files.",
    )
    p.add_argument(
        "--section",
        default=None,
        metavar="<x|y|z>[@offset_mm]",
        help=(
            "Also render an INTERIOR cross-section through the given axis-aligned "
            "plane (offset defaults to the bbox center) so mating interiors read — "
            "a peg seated in a socket, a tooth on solid material, a lip in its "
            "groove. Sections the assembled model unless --part is given."
        ),
    )
    p.add_argument(
        "--part",
        default=None,
        help="With --section, cut this named part instead of the assembled model.",
    )
    p.add_argument(
        "--no-sections",
        action="store_true",
        help=(
            "Skip the automatic interior cross-sections. By default (when "
            "--section is not given) the assembly is cut through its x, y, and z "
            "center planes so interior engagement is always visible."
        ),
    )
    return p


def _parse_section(spec: str) -> tuple[str, float | None]:
    """Parse a ``--section`` value like ``z`` or ``z@10.5`` → ``(axis, offset)``."""
    axis, _, off = spec.partition("@")
    axis = axis.strip().lower()
    if axis not in ("x", "y", "z"):
        raise ValueError(f"section axis must be x, y, or z (got {axis!r})")
    offset = float(off.strip()) if off.strip() else None
    return axis, offset


def _resolve_sidecar(input_path: Path, stem: str | None) -> Path | None:
    """Find the ``<stem>.step.json`` sidecar for the given input."""
    input_path = input_path.resolve()
    if input_path.is_file():
        if input_path.name.endswith(".step.json"):
            return input_path
        if input_path.suffix == ".step":
            cand = input_path.with_suffix(".step.json")
            return cand if cand.is_file() else None
        return None
    if input_path.is_dir():
        if stem:
            cand = input_path / f"{stem}.step.json"
            return cand if cand.is_file() else None
        sidecars = sorted(input_path.glob("*.step.json"))
        return sidecars[0] if len(sidecars) == 1 else (sidecars[0] if sidecars else None)
    return None


def _err(message: str, code: str = "VALIDATION_FAILED") -> int:
    print(json.dumps({"ok": False, "error": {"code": code, "message": message}}))
    return 2


def main(argv: Sequence[str] | None = None) -> int:
    args = build_parser().parse_args(list(argv) if argv is not None else None)
    if not args.input.exists():
        return _err(f"input not found: {args.input}")

    sidecar = _resolve_sidecar(args.input, args.stem)
    if sidecar is None:
        return _err(
            f"no .step.json sidecar found for {args.input} — generate the model "
            "first with scripts/cad"
        )

    try:
        meta = json.loads(sidecar.read_text(encoding="utf-8"))
    except Exception as exc:
        return _err(f"failed to read sidecar {sidecar.name}: {exc}")

    base_dir = sidecar.parent
    stem = sidecar.name[: -len(".step.json")]
    warnings = meta.get("validation", {}).get("warnings", []) or []

    from cadpy.render_part import render_stl_section_to_png, render_stl_to_png

    review_dir = base_dir / f"{stem}_review"

    # Assembled model (always written by cadpy as <stem>.stl).
    assembled_stl = base_dir / f"{stem}.stl"
    assembled_png = None
    if assembled_stl.is_file():
        rendered = render_stl_to_png(assembled_stl, review_dir / "_assembled.png")
        assembled_png = str(rendered) if rendered else None

    # Per-part renders. For single-part projects there is no parts[] list; the
    # assembled render is the part.
    renders: list[dict] = []
    for part in meta.get("parts", []) or []:
        name = str(part.get("name", "")) or "part"
        rel = part.get("stlPath", "")
        stl_path = (base_dir / rel).resolve()
        if not stl_path.is_file():
            renders.append({"part": name, "stl_path": str(stl_path), "png_path": None})
            continue
        rendered = render_stl_to_png(stl_path, review_dir / f"{name}.png")
        renders.append(
            {
                "part": name,
                "stl_path": str(stl_path),
                "png_path": str(rendered) if rendered else None,
            }
        )

    # Interior cross-sections so mating interiors read — a peg seated in a socket,
    # a tooth on solid material, a lip inside its groove — which exterior views
    # hide. An explicit `--section` cuts one targeted plane (assembly or --part);
    # otherwise we auto-cut the assembly through its x, y, and z centers so
    # interior engagement is ALWAYS visible without the reviewer having to ask.
    # `--no-sections` opts out for speed.
    section_pngs: list[dict] = []
    if args.section:
        try:
            axis, offset = _parse_section(args.section)
        except ValueError as exc:
            return _err(str(exc))
        if args.part:
            match = next(
                (p for p in (meta.get("parts") or []) if str(p.get("name")) == args.part),
                None,
            )
            if match is None:
                return _err(f"--part {args.part!r} not found in {sidecar.name}")
            sec_stl = (base_dir / match.get("stlPath", "")).resolve()
            sec_name = args.part
        else:
            sec_stl = assembled_stl
            sec_name = stem
        if sec_stl.is_file():
            out = render_stl_section_to_png(
                sec_stl,
                review_dir / f"{sec_name}_section_{axis}.png",
                axis=axis,
                offset=offset,
            )
            section_pngs.append(
                {"axis": axis, "part": sec_name, "png_path": str(out) if out else None}
            )
    elif not args.no_sections and assembled_stl.is_file():
        for axis in ("x", "y", "z"):
            out = render_stl_section_to_png(
                assembled_stl,
                review_dir / f"{stem}_section_{axis}.png",
                axis=axis,
                offset=None,
            )
            section_pngs.append(
                {"axis": axis, "part": stem, "png_path": str(out) if out else None}
            )

    print(
        json.dumps(
            {
                "ok": True,
                "stem": stem,
                "warnings": warnings,
                "assembled_png": assembled_png,
                "renders": renders,
                # First cross-section path, kept for back-compat with callers that
                # read a single `section_png`; `section_pngs` carries all of them.
                "section_png": next(
                    (s["png_path"] for s in section_pngs if s["png_path"]), None
                ),
                "section_pngs": section_pngs,
            }
        )
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
