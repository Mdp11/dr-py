"""The `${token}` template engine behind export naming (spec 2026-08-19 §4).

One vocabulary, four contexts (zip filename, entry name, folder path, split
filename). Two-phase by design: `validate_tokens` runs UP FRONT at the route
(unknown tokens are a 422 naming the entry — a typo silently shipped verbatim
into a filename contract is worse than a loud failure), while `substitute`
never raises and leaves unknown tokens verbatim, so it stays safe to call on
already-validated input without re-deriving the context's vocabulary.

This module OWNS `sanitize_stem` — the character-level cleanup that turns
free-form user text into a safe filename/path-segment STEM — but the
*application* of it to a rendered template stays at the archive boundary in
`routes/exports.py`, the same zip-slip seam that module documents.
`folder_segments` is the one exception here: it must reason about path
SEGMENTS (absolute/empty/traversal), which a per-stem sanitizer cannot, so it
owns the segment rules and delegates the per-segment character cleaning to
`sanitize_stem`.
"""

from __future__ import annotations

import re
from collections.abc import Iterable, Mapping

TOKEN_RE = re.compile(r"\$\{([^}]*)\}")

CONTEXT_TOKENS: frozenset[str] = frozenset({"rev", "date", "project"})
#: entry names, folder paths, the zip filename
NAME_TOKENS: frozenset[str] = CONTEXT_TOKENS | {"name"}
#: split filenames additionally know the element id
SPLIT_TOKENS: frozenset[str] = NAME_TOKENS | {"id"}

#: Sanitized-stem length cap. Well under every filesystem's 255-byte limit
#: even after the `.json` extension and a `_NN` dedupe suffix.
MAX_FILENAME_LEN = 120
_UNSAFE = set('/\\:*?"<>|')


def validate_tokens(template: str, allowed: Iterable[str]) -> None:
    allowed_set = set(allowed)
    unknown = sorted(
        {m.group(1) for m in TOKEN_RE.finditer(template)} - allowed_set
    )
    if unknown:
        listed = ", ".join("${" + t + "}" for t in unknown)
        raise ValueError(f"unknown template token(s): {listed}")


def substitute(template: str, vars: Mapping[str, str]) -> str:
    return TOKEN_RE.sub(lambda m: vars.get(m.group(1), m.group(0)), template)


def sanitize_stem(name: str) -> str:
    """Neutralize a filename STEM before it reaches any archive-member or
    filesystem path — the boundary where free-form user text (an artifact
    name, a `${name}`-templated element name) turns into a path component an
    unpacking tool will honor verbatim. `zipfile.ZipInfo` does not sanitize
    its `filename`, so an uncleaned stem becomes a zip-slip: unzipping walks
    OUTSIDE the archive root. Two independent hazards, both closed here:

    1. An EMBEDDED separator (`/`, `\\`) turns one path segment into several
       — stripped along with the other filesystem-unsafe characters.
    2. A stem that is nothing BUT dots (`"."`, `".."`, `"..."`, ...) is
       indistinguishable from a self/parent-directory reference once it is
       used as a whole path segment — as this module's own callers do for a
       `stem.ext` filename (harmless: `"..".ext` is just an odd filename,
       never a directory token) but as split-entry ZIP FOLDER names are NOT
       (`"../evil.json"` walks up a directory for real). Since this function
       cannot know which shape its caller will build, it neutralizes the
       all-dots case unconditionally rather than trusting every caller to
       reason about it — the cost is a same-length run of `_` in the rare
       case a stem really was all dots, in exchange for the property that
       output is NEVER `"."`/`".."`-equivalent as a lone path segment.
       Empty input stays empty (`""` is not "all dots" — no dots at all) so
       callers that fall back through `... or fallback or "element"` still
       reach that fallback.
    """
    cleaned = "".join("_" if ch in _UNSAFE or ord(ch) < 32 else ch for ch in name)
    cleaned = cleaned.strip()[:MAX_FILENAME_LEN].strip()
    if cleaned and not cleaned.strip("."):
        cleaned = "_" * len(cleaned)
    return cleaned


def folder_segments(rendered: str) -> list[str]:
    """Path segments for a RENDERED folder template. `""` -> [] (root)."""
    if not rendered:
        return []
    if rendered.startswith(("/", "\\")):
        raise ValueError("folder path must be relative")
    segments: list[str] = []
    for raw in rendered.split("/"):
        cleaned = sanitize_stem(raw)
        if not cleaned:
            raise ValueError("folder path has an empty segment")
        segments.append(cleaned)
    return segments
