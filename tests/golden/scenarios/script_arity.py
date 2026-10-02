"""The entry arity of a snippet's top-level ``def``, which the engine scans for
without a Python parser: parameter shapes, strings and comments that mention a
``def``, nesting, and files that do not parse. ``entry_points`` is what
``derive_entry_points`` accepts of the code: an entry is in it when any
top-level ``def`` of its name takes an accepted count."""

from __future__ import annotations

from typing import Any

from data_rover.core.script.lint import derive_entry_points, entry_arity

from ..driver import scenario

_CASES: list[tuple[str, str]] = [
    ("def value(): pass", "value"),
    ("def value(a): pass", "value"),
    ("def value(a, b): pass", "value"),
    ("def value(a, b, c): return 1", "value"),
    ("def value(a, b=(1, 2), c=[3, 4]): pass", "value"),
    ("def value(a, b={'k': 1, 'j': 2}, c=f(1, 2)): pass", "value"),
    ("def value(a, b=')', c='#', d=\"(\"): pass", "value"),
    ("def value(a, b=''')\n,''', c=1): pass", "value"),
    ("def value(a=lambda x, y: x, b=2): pass", "value"),
    ("def value(a: int, b: dict[str, int] = {}) -> list[int, str]: pass", "value"),
    ("def value(a, /, b): pass", "value"),
    ("def value(a, b, /): pass", "value"),
    ("def value(a, *, b): pass", "value"),
    ("def value(a, *args): pass", "value"),
    ("def value(a, **kw): pass", "value"),
    ("def value(a, b=1, *args, c, **kw): pass", "value"),
    ("def value(*args): pass", "value"),
    ("def value(**kw): pass", "value"),
    ("def value(a, b=2*3, c=2**3): pass", "value"),
    ("def value(\n    a,  # first, with a comma\n    b,\n    c,\n): pass", "value"),
    ("def value (a, b): pass", "value"),
    ("def value[T](a: T, b): pass", "value"),
    ("def value(a, \\\n  b): pass", "value"),
    ("@decorator\ndef value(a, b): pass", "value"),
    ("@d(1, 2)\n@e\ndef value(a): pass", "value"),
    ("class C:\n    def value(self, a, b): pass\n", "value"),
    ("def other():\n    def value(a, b, c): pass\n", "value"),
    ("if True:\n    def value(a): pass\n", "value"),
    ("def value(a): pass\ndef value(a, b): pass", "value"),
    ("async def value(a): pass\ndef value(a, b): pass", "value"),
    ("async def value(a): pass", "value"),
    ('x = """\ndef value(a, b)\n"""\ndef value(a): pass', "value"),
    ('x = """\ndef value(a, b)\n"""', "value"),
    ("x = '''def value(a)\n'''", "value"),
    ("# def value(a, b)\ndef value(a): pass", "value"),
    ("# def value(a, b)\n", "value"),
    ("x = (1,\ndef value(a))", "value"),
    ("x = [\n1,\n]\ndef value(a, b): pass", "value"),
    ("x = 1 \\\ndef value(a): pass", "value"),
    ("s = rb'\\'' \ndef value(a, b): pass", "value"),
    ("s = f\"{d['k']}\" + F'{{'\ndef value(a): pass", "value"),
    ('s = f"{d["k"]}"\ndef value(a): pass', "value"),
    ("if 1:\n\tx = 1\ndef value(a,\tb):\n\treturn 1", "value"),
    ("def value(a, b):\r\n    return 1\r\n", "value"),
    ("x = 1\r\ndef value(a):\r\n    pass\r\n", "value"),
    ("def valué(a, b): pass", "value"),
    ("def valué(a, b): pass", "valué"),
    ("def ｖalue(a, b): pass", "value"),
    ("def значение(a): pass\ndef value(a, b, c): pass", "value"),
    ("def step(a): pass", "step"),
    ("def transform(a): pass\ndef value(a, b): pass", "transform"),
    ("def transform(a, b): pass\ndef transform(a): pass", "transform"),
    ("def transform(a): pass\ndef transform(a, b): pass", "transform"),
    ("def transform(a, b): pass\ndef value(a): pass\ndef transform(a, b, c): pass", "transform"),
    ("def step(a, b): pass\ndef step(a): pass", "step"),
    ("def value(a, b, c): pass\ndef value(a, b): pass", "value"),
    ("def transform(a): pass\nx = (1,", "transform"),
    ("def transform(a, b): pass\ndef transform(a", "transform"),
    ("def value(a): pass", "step"),
    ("", "value"),
    ("value = 1", "value"),
    ("def values(a): pass", "value"),
    ("def value(a): pass; x = 1", "value"),
    ("def value(a, a): pass", "value"),
    # Files the oracle does not parse (null) and the scan sees.
    ("def value(a): pass\nx = (1,", "value"),
    ("def value(a): pass\nx = 1)", "value"),
    ("def value(a): pass\nx = (1]", "value"),
    ("def value(a): pass\nx = 'abc", "value"),
    ("def value(a): pass\nx = '''abc", "value"),
    ("def value(a, b", "value"),
    ("def value", "value"),
    ("def value:", "value"),
]

# Files the oracle does not parse that the scan cannot tell from valid code.
_UNPARSED: list[tuple[str, str]] = [
    ("def value(a, b): pass\nx = = 1", "value"),
    ("def value(a, b):\nreturn 1", "value"),
]


@scenario("script_arity")
def script_arity() -> Any:
    def row(case: tuple[str, str]) -> dict[str, Any]:
        code, name = case
        return {
            "code": code,
            "name": name,
            "arity": entry_arity(code, name),
            "entry_points": derive_entry_points(code),
        }

    return {
        "cases": [row(c) for c in _CASES],
        "unparsed": [row(c) for c in _UNPARSED],
    }
