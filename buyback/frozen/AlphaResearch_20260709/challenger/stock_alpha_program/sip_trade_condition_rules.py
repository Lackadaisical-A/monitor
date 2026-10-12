#!/usr/bin/env python3
"""Causal Alpaca SIP trade-condition eligibility rules.

Raw SIP messages include both ordinary executions and reports that must not be
treated as current price formation.  These rules reproduce Alpaca's published
minute-bar condition table while retaining odd lots as separately measurable
executed volume.
"""

from __future__ import annotations

from collections.abc import Iterable


SOURCE_URL = "https://docs.alpaca.markets/us/docs/market-data-faq"

# Codes documented in Alpaca's tape-specific bar aggregation table.  A blank
# condition is a regular Tape A/B sale and is represented here by no code.
KNOWN_CODES = frozenset(
    {
        "@", "A", "B", "C", "D", "E", "F", "G", "H", "I", "K",
        "L", "M", "N", "O", "P", "Q", "R", "T", "U", "V", "W",
        "X", "Y", "Z", "4", "5", "6", "7", "9",
    }
)

# These messages do not update Alpaca's reported minute volume.
VOLUME_DISQUALIFIERS = frozenset({"M", "Q", "9"})

# These conditions do not update minute open/close or high/low.  Tape A/B code
# B is an average-price report; Tape C code B is a price-forming bunched trade.
PRICE_DISQUALIFIERS_COMMON = frozenset(
    {"C", "G", "H", "I", "M", "N", "P", "Q", "R", "U", "V", "W", "Z", "4", "7", "9"}
)


def normalize_conditions(value: Iterable[object] | object | None) -> tuple[str, ...]:
    if value is None:
        return ()
    values = (value,) if isinstance(value, (str, bytes)) else value
    output = []
    for item in values:
        code = str(item).strip().upper()
        if code:
            output.append(code)
    return tuple(sorted(set(output)))


def eligibility(conditions, tape: object | None) -> dict[str, object]:
    """Return deterministic volume/price eligibility for one raw trade."""
    codes = normalize_conditions(conditions)
    tape_code = str(tape or "").strip().upper()
    unknown = tuple(code for code in codes if code not in KNOWN_CODES)
    volume_eligible = not unknown and not set(codes).intersection(VOLUME_DISQUALIFIERS)
    price_disqualifiers = set(PRICE_DISQUALIFIERS_COMMON)
    if tape_code != "C":
        price_disqualifiers.add("B")
    price_forming = (
        volume_eligible
        and not set(codes).intersection(price_disqualifiers)
    )
    return {
        "conditions": codes,
        "tape": tape_code,
        "unknown_conditions": unknown,
        "volume_eligible": bool(volume_eligible),
        "price_forming": bool(price_forming),
        "odd_lot": "I" in codes,
    }

