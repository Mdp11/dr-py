"""``ruff format`` seam for ``POST /snippets/format``.

Lives in the api package, not ``core``: it shells out to a binary, and
``core`` is deliberately dependency-light (``core/script/runner.py`` is
sandbox-agnostic by design). It is the sibling of ``script_runner.py``, but
carries none of that module's tripwires — ``ruff format`` PARSES and PRINTS
the snippet, it never executes it, so untrusted input needs no sandbox here.

``indent-width`` is passed explicitly rather than left to ruff's default so
the formatter and the editor's own ``INDENT_WIDTH`` (four spaces, see
``frontend/src/lib/editor/indent.ts``) cannot drift apart silently.
``--isolated`` keeps a stray ``ruff.toml``/``pyproject.toml`` in whatever
directory the server happens to run from out of the decision — snippet
formatting must not depend on the deployment's cwd. Line length stays at
ruff's default.
"""

from __future__ import annotations

import shutil
import subprocess
from dataclasses import dataclass

#: Spaces per indentation level handed to ruff. Must equal the editor's
#: ``INDENT_WIDTH`` in ``frontend/src/lib/editor/indent.ts``.
FORMAT_INDENT_WIDTH = 4


class FormatUnavailable(RuntimeError):
    """``ruff`` is not on PATH — the route answers 503, never 500."""


class FormatTimeout(RuntimeError):
    """``ruff`` did not finish inside the configured budget."""


class FormatSyntaxError(ValueError):
    """The snippet does not parse; ruff's own message is carried through."""


@dataclass(frozen=True)
class FormatResult:
    code: str
    #: Whether formatting actually rewrote anything — lets the client skip a
    #: no-op editor transaction (and therefore a no-op undo entry).
    changed: bool


#: Sentinel distinct from ``None``: ``None`` is a RESOLVED "ruff is absent"
#: answer, so it cannot double as "not looked yet".
_UNRESOLVED: object = object()
_ruff_path: object | str | None = _UNRESOLVED


def ruff_path() -> str | None:
    """Resolved ``ruff`` executable, or None. Cached: PATH does not change
    under a running process, and a formatter is on an interactive path."""
    global _ruff_path
    if _ruff_path is _UNRESOLVED:
        _ruff_path = shutil.which("ruff")
    return _ruff_path  # type: ignore[return-value]


def reset_ruff_path_cache() -> None:
    """Test seam — drop the cached resolution."""
    global _ruff_path
    _ruff_path = _UNRESOLVED


def format_code(code: str, *, timeout_s: float) -> FormatResult:
    exe = ruff_path()
    if exe is None:
        raise FormatUnavailable("code formatter (ruff) is not installed")
    try:
        proc = subprocess.run(  # noqa: S603  (fixed argv, no shell)
            [
                exe,
                "format",
                "-",
                "--stdin-filename",
                "snippet.py",
                "--isolated",
                "--config",
                f"indent-width={FORMAT_INDENT_WIDTH}",
            ],
            input=code,
            capture_output=True,
            text=True,
            timeout=timeout_s,
            check=False,
        )
    except subprocess.TimeoutExpired as exc:
        raise FormatTimeout("formatting timed out") from exc
    if proc.returncode != 0:
        raise FormatSyntaxError(_first_message(proc.stderr))
    return FormatResult(code=proc.stdout, changed=proc.stdout != code)


def _first_message(stderr: str) -> str:
    """First meaningful line of ruff's stderr — the parse error itself. The
    rest is context the editor has no room for."""
    for line in stderr.splitlines():
        stripped = line.strip()
        if stripped:
            return stripped
    return "could not parse this snippet"
