"""Project entrypoint.

The runner imports this file with ``project_dir`` on ``sys.path`` and calls
``gen_step()`` to obtain the shape to export.

Order:
    1. Load params.
    2. Validate them — bad params fail loudly here, before geometry.
    3. Build the assembly.
    4. Return it from ``gen_step()`` — the runner exports it as STL + STEP.
       Return a ``cq.Workplane`` / ``cq.Shape`` for a single solid, or a
       ``cq.Assembly`` for a multi-part design (see references/assembly.md).
"""

from __future__ import annotations

from params import Params
from validation import validate_params
from assemblies.product import make_assembly


def gen_step():
    p = Params()
    validate_params(p)
    return make_assembly(p)
