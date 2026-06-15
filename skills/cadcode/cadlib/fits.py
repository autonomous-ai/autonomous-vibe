"""FDM mating fits — one source of truth for assembled-part clearances.

A mating interface (tab/slot, lip/groove, peg/socket, lid/cavity) has a male and
a female half that **must** derive from one nominal dimension plus a clearance,
or they drift until the parts jam or fall apart. These helpers pick the correct
per-side FDM clearance for a named fit class and apply it in one place, so both
halves stay locked to the same nominal:

    from cadlib.fits import peg_for, slot_for

    cavity = inner_l                     # the female, owned by the base
    lip    = peg_for(cavity, "slip")     # the male, derived — can't drift

Per-side clearances assume a calibrated 0.4 mm-nozzle FDM printer. Tune once
here if your printer runs tight or loose; every helper that reads the table
follows.
"""

from __future__ import annotations

# Per-side clearance (mm) by fit class. Positive = gap; negative = interference.
# Ordered tight -> loose. ``press`` is a true interference (seats with force or
# heat); for a structural press fit also see ``cutouts.add_press_fit_pocket``.
FIT_TABLE: dict[str, float] = {
    "press": -0.05,  # interference — won't fall out; needs force / heat to seat
    "snug": 0.10,    # light friction; hand-press, stays put without force
    "slip": 0.20,    # slides / seats freely by hand — default assembled fit
    "free": 0.40,    # loose, easy hand assembly; drops in with no fuss
}

DEFAULT_FIT = "slip"


def mating_clearance(fit: str = DEFAULT_FIT) -> float:
    """Per-side FDM clearance (mm) for a named fit class (see ``FIT_TABLE``)."""
    try:
        return FIT_TABLE[fit]
    except KeyError:
        raise ValueError(
            f"unknown fit class {fit!r}; choose one of {sorted(FIT_TABLE)}"
        ) from None


def slot_for(tab: float, fit: str = DEFAULT_FIT) -> float:
    """Female opening for a male of size ``tab`` — ``tab + 2·clearance``.

    Build the male at ``tab`` and the female at ``slot_for(tab, fit)`` so the two
    halves are always one edit apart and never drift.
    """
    if tab <= 0:
        raise ValueError(f"tab must be > 0, got {tab}")
    return tab + 2 * mating_clearance(fit)


def peg_for(hole: float, fit: str = DEFAULT_FIT) -> float:
    """Male peg/lip for a female of size ``hole`` — ``hole − 2·clearance``.

    The inverse of :func:`slot_for`: derive the male from the female the base
    already owns, so the mate shares one source-of-truth dimension.
    """
    if hole <= 0:
        raise ValueError(f"hole must be > 0, got {hole}")
    peg = hole - 2 * mating_clearance(fit)
    if peg <= 0:
        raise ValueError(
            f"fit {fit!r} clearance is too large for a {hole} mm hole "
            "(peg would be non-positive)"
        )
    return peg
