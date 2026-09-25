"""
hub/errors.py - the error taxonomy (doc 07). Every validation / gate / tool
wrapper returns a typed error object {code, class, message, refs, evidence} — never
a bare string — so retry policy, regression asserts, and the confidence gate can
key off a STABLE code + class.

Retry classes:
  transient     -> auto-retry with backoff
  deterministic -> send back to AI/user to fix (with error-diff)
  policy        -> STOP, never retry (needs human)
  resource      -> escalate / adjust limits, not raw retry
Codes are append-only: never change an existing code's meaning.
"""
from __future__ import annotations

TRANSIENT, DETERMINISTIC, POLICY, RESOURCE = "transient", "deterministic", "policy", "resource"

# code -> class (from doc 07; append-only). Prefix families map by suffix rule too.
REGISTRY = {
    "SCHEMA-001": DETERMINISTIC, "SCHEMA-002": DETERMINISTIC,
    "SEM-003": DETERMINISTIC, "SEM-004": DETERMINISTIC, "SEM-005": DETERMINISTIC, "SEM-006": DETERMINISTIC,
    "ORACLE-FAIL": DETERMINISTIC, "ORACLE-STALE": TRANSIENT, "ORACLE-AMEND-REQUIRED": POLICY,
    "COSIM-X-MISMATCH": DETERMINISTIC, "COSIM-STROBE-DIFF": DETERMINISTIC, "COSIM-RESET-DIFF": DETERMINISTIC,
    "SYNTH-LATCH": DETERMINISTIC, "SYNTH-BLACKBOX": DETERMINISTIC, "SYNTH-UNCONNECTED": DETERMINISTIC,
    "SYNTH-MULTIDRIVER": DETERMINISTIC, "SYNTH-FAIL": DETERMINISTIC,
    "IMPL-UNROUTED": DETERMINISTIC, "IMPL-UTIL-OVER": RESOURCE,
    "TIMING-WNS-NEG": DETERMINISTIC, "TIMING-UNCONSTRAINED": DETERMINISTIC,
    "BOARD-PIN-DUP": DETERMINISTIC, "BOARD-IOSTD-BAD": DETERMINISTIC,
    "BOARD-ID-MISMATCH": POLICY, "BOARD-RESERVED-PIN": POLICY,
    "JOB-TIMEOUT": RESOURCE, "JOB-CANCELLED": TRANSIENT, "JOB-ORPHANED": TRANSIENT,
    "JOB-BUDGET-EXCEEDED": RESOURCE,
    "SEC-PATH-TRAVERSAL": POLICY, "SEC-SYMLINK": POLICY, "SEC-CMD-NOT-ALLOWED": POLICY,
    "AI-PATCH-NODIFF": POLICY, "AI-PATCH-PRECOND": DETERMINISTIC,
    "AI-SET-PASSED-DENIED": POLICY, "AI-TOUCH-LOCKED": POLICY,
    "ENV-UNREACHABLE": TRANSIENT,
}

_PREFIX_DEFAULT = {"ERC": DETERMINISTIC, "SCHEMA": DETERMINISTIC, "SEM": DETERMINISTIC,
                   "DRC": DETERMINISTIC, "SEC": POLICY, "JOB": RESOURCE}


def classify(code: str) -> str:
    if code in REGISTRY:
        return REGISTRY[code]
    return _PREFIX_DEFAULT.get(code.split("-", 1)[0], DETERMINISTIC)


def err(code: str, message: str, *, refs=None, evidence=None, cls: str | None = None) -> dict:
    return {"code": code, "class": cls or classify(code), "message": message,
            "refs": list(refs or []), "evidence": evidence}


def should_retry(e: dict) -> bool:
    return e.get("class") == TRANSIENT


def needs_human(e: dict) -> bool:
    return e.get("class") == POLICY


def is_fixable(e: dict) -> bool:
    return e.get("class") == DETERMINISTIC


def gate_blocks_pass(errors: list[dict]) -> bool:
    """Confidence gate: any policy-class code forces a human / blocks auto-pass."""
    return any(needs_human(e) for e in errors)


if __name__ == "__main__":
    for c in ("SEM-005", "ERC-017", "JOB-TIMEOUT", "SEC-PATH-TRAVERSAL", "ORACLE-FAIL"):
        print(f"{c:22} -> {classify(c)}")
