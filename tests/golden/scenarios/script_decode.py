"""What the host makes of one embedded call's result text: the payload checked
for its entry, the read-set checked, an error kept as it came.

Each case is a harness answer text and its entry; ``decoded`` is what
``_TrustedSession.call`` answers for it, fed through the same ``json.loads`` the
host applies. The corpus is every embedded text of ``script_parity`` plus
hand-written texts a guest could send: payloads of the wrong shape, read-sets
with a bad member, non-finite numbers."""

from __future__ import annotations

import json
from typing import Any

from tests.script.trusted_runner import _TrustedSession

from ..driver import scenario
from ..tagged import tag
from .script_parity import embedded_results


class _Replay(_TrustedSession):
    """A session whose harness answer is fixed: ``call`` is the real one."""

    def __init__(self, answer: dict[str, Any]) -> None:
        self._answer = answer
        self.boot_error = None

    def call_harness(
        self,
        entry: str,
        element_ids: list[str],
        *,
        doc: object | None = None,
        inputs: Any = None,
    ) -> dict[str, Any]:
        return self._answer


def _decoded(text: str, entry: str) -> dict[str, Any]:
    result = _Replay(json.loads(text)).call(entry, [])
    error = result.error
    return {
        "payload": None if result.value is None else tag(result.value),
        "error": None
        if error is None
        else {
            "kind": error.kind,
            "message": error.message,
            "traceback": error.traceback,
        },
        "reads": None
        if result.reads is None
        else sorted(
            ([t, i] for t, i in result.reads),
            key=lambda k: (k[0], k[1] is not None, k[1] or ""),
        ),
        "stdout": result.stdout,
    }


def _text(
    payload: str, reads: str = "[]", error: str = "null", stdout: str = '""'
) -> str:
    return f'{{"payload": {payload}, "error": {error}, "reads": {reads}, "stdout": {stdout}}}'


def _reads_list(count: int) -> str:
    return "[" + ", ".join(f'["el", "k{i}"]' for i in range(count)) + "]"


_ERROR = (
    '{"kind": "runtime", "message": "ValueError: x", '
    '"traceback": "Traceback (most recent call last):\\nValueError: x\\n"}'
)

_VALUE_PAYLOADS = [
    '{"kind": "scalar", "value": 1}',
    '{"kind": "scalar", "value": 1.0}',
    '{"kind": "scalar", "value": -0.0}',
    '{"kind": "scalar", "value": -0}',
    '{"kind": "scalar", "value": true}',
    '{"kind": "scalar", "value": null}',
    '{"kind": "scalar"}',
    '{"kind": "scalar", "value": 1152921504606846976}',
    '{"kind": "scalar", "value": 123456789012345678901234567890}',
    '{"kind": "scalar", "value": NaN}',
    '{"kind": "scalar", "value": Infinity}',
    '{"kind": "scalar", "value": -Infinity}',
    '{"kind": "scalar", "value": 1e400}',
    '{"kind": "scalar", "value": "\\ud83d\\ude00 caf\\u00e9"}',
    '{"kind": "scalar", "value": 1, "extra": [1, 2]}',
    '{"kind": "scalar", "value": 1, "kind": "element", "id": "n1"}',
    '{"kind": "scalar", "value": [1]}',
    '{"kind": "scalar", "value": {"a": 1}}',
    '{"kind": "scalars", "values": []}',
    '{"kind": "scalars", "values": [1, 2.5, "x", true, null]}',
    '{"kind": "scalars", "values": [NaN, Infinity, -Infinity]}',
    '{"kind": "scalars", "values": [1, [2]]}',
    '{"kind": "scalars", "values": [{"a": 1}]}',
    '{"kind": "scalars", "values": "abc"}',
    '{"kind": "scalars", "values": null}',
    '{"kind": "scalars"}',
    '{"kind": "element", "id": "n1"}',
    '{"kind": "element", "id": ""}',
    '{"kind": "element", "id": 5}',
    '{"kind": "element", "id": null}',
    '{"kind": "element"}',
    '{"kind": "elements", "ids": []}',
    '{"kind": "elements", "ids": ["n1", "n1", "n2"]}',
    '{"kind": "elements", "ids": ["n1", 2]}',
    '{"kind": "elements", "ids": ["n1", null]}',
    '{"kind": "elements", "ids": "n1"}',
    '{"kind": "elements"}',
    '{"kind": "banana"}',
    '{"kind": 5}',
    '{"kind": null, "value": 1}',
    '{"kind": "json", "value": 1}',
    '{"kind": "scalar", "value": 1, "__proto__": 2}',
    "{}",
    "[]",
    "[1, 2]",
    "5",
    '"scalar"',
    "null",
    "true",
]

_STEP_PAYLOADS = [
    '{"nodes": []}',
    '{"nodes": ["n1", "n2", "n2"]}',
    '{"nodes": ["a", 1, 2.5, true, 1.0]}',
    '{"nodes": [NaN, Infinity, -Infinity]}',
    '{"nodes": [123456789012345678901234567890]}',
    '{"nodes": ["n1", null]}',
    '{"nodes": ["n1", [1]]}',
    '{"nodes": ["n1", {"a": 1}]}',
    '{"nodes": "n1"}',
    '{"nodes": null}',
    '{"nodes": [], "extra": 1}',
    '{"kind": "elements", "ids": ["n1"]}',
    "{}",
    "[]",
    "null",
    "7",
]

_TRANSFORM_PAYLOADS = [
    '{"kind": "json", "value": {"n": 3, "rows": [1, 2.5, "x"], "done": true}}',
    '{"kind": "json", "value": [1, 1.0, {"a": null}]}',
    '{"kind": "json", "value": null}',
    '{"kind": "json", "value": 7}',
    '{"kind": "json", "value": "text"}',
    '{"kind": "json", "value": {"nan": NaN, "inf": [Infinity, -Infinity]}}',
    '{"kind": "json", "value": {"__proto__": {"x": 1}, "k": 1, "k": 2}}',
    '{"kind": "json", "value": 123456789012345678901234567890, "extra": 1}',
    '{"kind": "json"}',
    '{"kind": "scalar", "value": 1}',
    '{"kind": "banana", "value": 1}',
    '{"value": 1}',
    "{}",
    "[]",
    "null",
    '"json"',
]

_READS = [
    "[]",
    '[["el", "n1"]]',
    '[["children", "n1"], ["el", "n1"], ["scan", null]]',
    '[["el", "n1"], ["el", "n1"], ["out", "n1"]]',
    '[["scan", null], ["scan", null]]',
    '[["bogus", "n1"]]',
    '[["", ""]]',
    f'[["{"t" * 32}", "n1"]]',
    f'[["{"t" * 33}", "n1"]]',
    f'[["el", "{"i" * 512}"]]',
    f'[["el", "{"i" * 513}"]]',
    f'[["el", "{"\U0001f600" * 300}"]]',
    f'[["el", "{"\U0001f600" * 513}"]]',
    f'[["{"\U0001f600" * 20}", "n1"]]',
    f'[["{"\U0001f600" * 33}", "n1"]]',
    '[[5, "n1"]]',
    '[[null, "n1"]]',
    '[["el", 5]]',
    '[["el", ["n1"]]]',
    '[["el"]]',
    '[["el", "n1", "extra"]]',
    "[[]]",
    '["el"]',
    '["ab"]',
    "[null]",
    '[{"0": "el", "1": "n1"}]',
    '[["el", "n1"], 5]',
    '[["el", "n1"], ["el", 5]]',
    "{}",
    '{"el": "n1"}',
    '"el"',
    "5",
    "true",
    "null",
    _reads_list(2000),
    _reads_list(2001),
]

_ERRORS = [
    _ERROR,
    '{"kind": "syntax", "message": "invalid syntax (<snippet>, line 1)", "traceback": null}',
    '{"kind": "timeout", "message": "wall time exceeded", "traceback": null}',
    '{"kind": "memory", "message": "out of memory", "traceback": null}',
    '{"kind": "limit", "message": "too many ops", "traceback": null}',
]


def _corpus() -> list[tuple[str, str]]:
    texts: list[tuple[str, str]] = embedded_results()
    texts += [("value", _text(p, '[["el", "n1"]]')) for p in _VALUE_PAYLOADS]
    texts += [("step", _text(p, '[["el", "n1"]]')) for p in _STEP_PAYLOADS]
    texts += [("transform", _text(p, "[]")) for p in _TRANSFORM_PAYLOADS]
    # A payload every entry judges differently.
    shared = (
        '{"kind": "json", "value": {"nodes": ["n1"]}, "nodes": ["n1"], "ids": ["n1"]}'
    )
    texts += [(entry, _text(shared)) for entry in ("value", "step", "transform")]
    # The read-set is judged the same whatever the entry.
    texts += [
        ("value", _text('{"kind": "scalar", "value": 1}', reads)) for reads in _READS
    ]
    texts += [
        (entry, _text(payload, reads))
        for reads in _READS[:6]
        for entry, payload in (
            ("step", '{"nodes": ["n1"]}'),
            ("transform", '{"kind": "json", "value": 1}'),
        )
    ]
    # An error wins over whatever else the answer carries; stdout stays on it.
    texts += [
        (entry, _text(payload, '[["el", "n1"]]', error, '"printed\\n"'))
        for error in _ERRORS
        for entry, payload in (
            ("value", "null"),
            ("value", '{"kind": "scalar", "value": 1}'),
            ("step", '{"nodes": ["n1"]}'),
            ("transform", '{"kind": "json", "value": 1}'),
        )
    ]
    # A malformed payload keeps the call's stdout and drops its read-set.
    texts += [
        (entry, _text("5", '[["el", "n1"]]', "null", '"printed\\n"'))
        for entry in ("value", "step", "transform")
    ]
    # Output is carried as it came.
    texts += [
        ("value", _text('{"kind": "scalar", "value": 1}', stdout='"é\\ud83d\\ude00"'))
    ]
    return texts


@scenario("script_decode")
def script_decode() -> Any:
    return [
        {"text": text, "entry": entry, "decoded": _decoded(text, entry)}
        for entry, text in _corpus()
    ]
