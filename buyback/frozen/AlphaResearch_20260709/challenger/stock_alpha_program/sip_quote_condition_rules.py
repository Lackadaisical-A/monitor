#!/usr/bin/env python3
"""Tape-specific eligibility rules for causal consolidated stock quotes."""

from __future__ import annotations

from collections.abc import Iterable


UTP_SOURCE_URL = "https://www.utpplan.com/DOC/UtpBinaryOutputSpec-1.2a.pdf"
CTA_SOURCE_URL = (
    "https://www.ctaplan.com/publicdocs/ctaplan/notifications/trader-update/"
    "CQS_BINARY_OUTPUT_SPECIFICATION.pdf"
)

# Both sides are BBO eligible under the primary specifications. CTA E/F are
# side-specific and cannot support two-sided depth/microprice features. UTP Y
# is one-sided and cannot support them either. Opening condition O is BBO
# eligible and remains valid if it genuinely appears inside the causal window.
TWO_SIDED_BBO_ELIGIBLE = {
    "A": frozenset({"A", "B", "H", "O", "R", "W"}),
    "B": frozenset({"A", "B", "H", "O", "R", "W"}),
    "C": frozenset({"A", "B", "H", "O", "R"}),
}
KNOWN = {
    "A": frozenset({"4", "A", "B", "C", "E", "F", "H", "L", "N", "O", "R", "U", "W"}),
    "B": frozenset({"4", "A", "B", "C", "E", "F", "H", "L", "N", "O", "R", "U", "W"}),
    "C": frozenset({"4", "A", "B", "F", "H", "I", "L", "N", "O", "R", "U", "X", "Y", "Z"}),
}


def normalize_conditions(value: Iterable[object] | object | None) -> tuple[str, ...]:
    if value is None:
        return ()
    values = (value,) if isinstance(value, (str, bytes)) else value
    return tuple(
        sorted(
            {
                str(item).strip().upper()
                for item in values
                if str(item).strip()
            }
        )
    )


def eligibility(conditions, tape: object | None) -> dict[str, object]:
    codes = normalize_conditions(conditions)
    tape_code = str(tape or "").strip().upper()
    known = KNOWN.get(tape_code, frozenset())
    unknown = tuple(code for code in codes if code not in known)
    eligible_codes = TWO_SIDED_BBO_ELIGIBLE.get(tape_code, frozenset())
    two_sided_bbo = (
        bool(codes)
        and not unknown
        and all(code in eligible_codes for code in codes)
    )
    return {
        "conditions": codes,
        "tape": tape_code,
        "unknown_conditions": unknown,
        "two_sided_bbo_eligible": bool(two_sided_bbo),
    }
