"""Project entrypoint.

The runner imports this file with ``project_dir`` on ``sys.path`` and
reads the ``result`` global at the end.

Order:
    1. Load params.
    2. Validate them — bad params fail loudly here, before geometry.
    3. Build the assembly.
    4. Assign to ``result`` — the runner exports it as STL + STEP + PNG.
"""

from __future__ import annotations

from params import Params
from validation import validate_params
from assemblies.product import make_assembly

p = Params()
validate_params(p)

result = make_assembly(p)
