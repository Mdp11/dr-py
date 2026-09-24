"""``re.search`` and ``re.fullmatch``, which a ``matches`` criterion (and a
pattern facet) runs: patterns with the subjects that tell a faithful
translation from a naive one, and single code points against a few patterns."""

from __future__ import annotations

import re
import sys
import warnings
from typing import Any

from ..driver import scenario

_KELVIN = "\u212a"
_DOTTED_I = "İ"
_DOTLESS_I = "ı"
_LONG_S = "ſ"
_ARABIC_3 = "٣"
_LINE_SEP = "\u2028"
_PARA_SEP = "\u2029"
_EMOJI = chr(0x1F600)
_DESERET = chr(0x10400)
_ADLAM = chr(0x1E900)
# Subjects holding astral code points: a JavaScript search may try a start
# between the two halves of a pair, where a look-around sees no neighbour.
_ASTRAL = [_EMOJI, "x" + _EMOJI, _EMOJI + "x", "abc" + _EMOJI + "def", _DESERET, _ADLAM]

_CASES: list[tuple[str, list[str]]] = [
    # Python-only syntax a naive translation gets wrong.
    (r"(?P<a>x)(?P=a)", ["xx", "xy", "x", "axxb"]),
    (r"\d", [_ARABIC_3, "3", "²", "a", ""]),
    (r"a$", ["a", "a\n", "a\n\n", "ab", "\na"]),
    (r"x{,2}y", ["xxy", "xy", "y", "xxxy", "x{,2}y"]),
    (r"[", []),
    # Literals and escapes.
    (r"abc", ["abc", "xabcx", "ab", "ABC"]),
    (r"a\.b", ["a.b", "axb"]),
    (r"\(\)\[\]\{\}\|\*\+\?\^\$\\", ["()[]{}|*+?^$\\", "()"]),
    (r"\-\#\ \&\~\/\"\'", ["-# &~/\"'", "-#"]),
    (r"\n", ["\n", "n", "\\n"]),
    (r"\t\r\f\v", ["\t\r\f\v", "\t\r"]),
    (r"\a", ["\x07", "a"]),
    (r"\x41", ["A", "a"]),
    (r"\u00e9", ["é", "e"]),
    (r"\U0001F600", ["😀", "x😀y", ":)"]),
    (r"\0", ["\x00", "0"]),
    (r"\07", ["\x07", "7"]),
    (r"\012", ["\n", "12"]),
    (r"\101", ["A", "101"]),
    (r"\1010", ["A0", "A"]),
    (r"é+", ["éé", "e"]),
    (r"😀{2}", ["😀😀", "😀"]),
    (r"]", ["]", "["]),
    (r"}", ["}", "{"]),
    (r"a{", ["a{", "a"]),
    (r"a{}", ["a{}", "a"]),
    (r"a{1", ["a{1", "a"]),
    (r"a{1,2x}", ["a{1,2x}", "a"]),
    (r"{", ["{"]),
    (r"a{,}", ["", "aaa", "b"]),
    (r"\z", ["", "a"]),
    (r"a\z", ["a", "a\n", "ab"]),
    (r"a\Z", ["a", "a\n", "ab"]),
    (r"\Aa", ["a", "ba", "\na"]),
    (r"\N{EM DASH}", ["—", "-"]),
    # Escapes re refuses.
    (r"\q", []),
    (r"a\\", ["a\\"]),
    ("a\\", []),
    (r"\x4", []),
    (r"\u12", []),
    (r"\U00110000", []),
    (r"\8", []),
    (r"\k", []),
    (r"\E", []),
    # The dot.
    (r".", ["", "\n", "\r", _LINE_SEP, _PARA_SEP, "a", "😀"]),
    (r"(?s).", ["", "\n", "\r", "a"]),
    (r"^.$", ["😀", "\r", "\n", "ab"]),
    (r"a.c", ["a\rc", f"a{_LINE_SEP}c", "a\nc"]),
    # The classes \w \d \s and their negations.
    (r"\w", ["é", "_", _ARABIC_3, _KELVIN, "²", "-", " ", "中", "\u0345", "·"]),
    (r"\W", ["é", "_", _ARABIC_3, _KELVIN, "²", "-", " "]),
    (r"\D", [_ARABIC_3, "²", "3", "a"]),
    (r"\d+", ["١٢", "12", "x"]),
    (r"\s", ["\x1c", "\x85", "\ufeff", " ", "\xa0", "\u200b", "\u3000", "\t", "a"]),
    (r"\S", ["\x1c", "\x85", "\ufeff", " ", "a"]),
    (r"[\d]", [_ARABIC_3, "a"]),
    (r"[^\d]", [_ARABIC_3, "a"]),
    (r"[\w-]", ["-", "a", ".", "é"]),
    (r"[\W\d]", ["3", "a", " ", _ARABIC_3]),
    (r"[^\W\d_]", ["a", "3", "_", _ARABIC_3, "é", "-"]),
    (r"[\s\S]", ["x", "\n", ""]),
    (r"[^\s\S]", ["x", "\n", ""]),
    # Word boundaries.
    (
        r"\bfoo\b",
        ["foo", "a foo b", "foobar", "éfoo", "fooé", "foo_", _ARABIC_3 + "foo"],
    ),
    (r"\bcaf\b", ["café", "caf", "caf!"]),
    (r"\b", ["", "a", " ", *_ASTRAL]),
    (r"\B", ["", "a", " ", "ab", *_ASTRAL]),
    (r"é\b", ["é", "éa", "é "]),
    (r"\Bé", ["aé", "é", " é"]),
    (r"x\b", ["x" + _KELVIN, "x²", "x" + _ARABIC_3, "x-"]),
    # Anchors.
    (r"^a", ["a", "ba", "\na", "b\na"]),
    (r"^$", ["", "\n", "\n\n", "a", *_ASTRAL]),
    (r"$", ["", "a", *_ASTRAL]),
    (r"^", ["", *_ASTRAL]),
    (r"\A\Z", ["", "\n", *_ASTRAL]),
    (r"(?!a)", ["a", *_ASTRAL]),
    (r"(?<!a)", ["a", *_ASTRAL]),
    (r"a|^", ["b", "a", *_ASTRAL]),
    (r"a|\b", ["", *_ASTRAL]),
    (r"a|\B", [" ", *_ASTRAL]),
    (r"(?m)^x|$", ["", "y", *_ASTRAL]),
    (r"(?m)a|^", ["b", *_ASTRAL]),
    (r"a\n$", ["a\n", "a\n\n"]),
    (r"^a\Z", ["a", "a\n"]),
    (r"(?m)^b", ["a\nb", "ab", "b"]),
    (r"(?m)a$", ["a\nb", "ab", "a", "a\n", "a\r\n"]),
    (r"(?m)^$", ["", "\n", "a\n\nb", "a", "a\n", *_ASTRAL]),
    (r"(?m)\Aa", ["b\na", "a"]),
    (r"(?m)a\Z", ["a\nb", "a", "a\n"]),
    # Classes.
    (r"[a-c]", ["a", "b", "d", "B"]),
    (r"[^a-c]", ["a", "d", ""]),
    (r"[]a]", ["]", "a", "b"]),
    (r"[^]a]", ["]", "b"]),
    (r"[a-]", ["-", "a", "b"]),
    (r"[-a]", ["-", "a", "b"]),
    (r"[a\-z]", ["-", "b", "z"]),
    (r"[\]]", ["]", "\\"]),
    (r"[\\]", ["\\", "]"]),
    (r"[.]", [".", "a"]),
    (r"[$^]", ["$", "^", "a"]),
    (r"[\b]", ["\x08", "b"]),
    (r"[\x41-\x43]", ["B", "D"]),
    (r"[\u00e0-\u00ff]", ["é", "e"]),
    (r"[😀-😂]", ["😁", "a"]),
    (r"[^😀]", ["😀", "a"]),
    (r"[\0-\x1f]", ["\x00", "\x1f", " "]),
    (r"[\101]", ["A", "1"]),
    (r"[\n]", ["\n", "n"]),
    (r"[a-b-c]", ["-", "c", "b", "d"]),
    (r"[\d-]", ["-", "3"]),
    (r"[\d-z]", []),
    (r"[a-\d]", []),
    (r"[z-a]", []),
    (r"[\q]", []),
    (r"[\8]", []),
    (r"[\400]", []),
    (r"[\A]", []),
    (r"[\z]", []),
    (r"[\B]", []),
    (r"[a", []),
    (r"[]", []),
    (r"[^]", []),
    # Classes Python reads as a future set operation or a nested class.
    (r"[[a]]", ["[a]", "a]"]),
    (r"[a--b]", ["-", "a"]),
    (r"[a&&b]", ["&", "b"]),
    (r"[a||b]", ["|", "b"]),
    (r"[a~~b]", ["~", "b"]),
    # Quantifiers.
    (r"a*", ["", "b", "aaa", *_ASTRAL]),
    (r"a+", ["", "a", "baab"]),
    (r"a?b", ["b", "ab", "aab"]),
    (r"a{2}", ["a", "aa", "aaa"]),
    (r"a{2,}", ["a", "aa", "aaaa"]),
    (r"a{1,2}", ["", "a", "aaa"]),
    (r"a{,2}", ["", "aaa"]),
    (r"a{0}b", ["b", "ab"]),
    (r"a{100}", ["a" * 100, "a" * 99]),
    (r"a*?b", ["aab", "b", "a"]),
    (r"a+?", ["a", ""]),
    (r"a??b", ["ab", "b"]),
    (r"a{1,2}?", ["a", "aa", ""]),
    (r"a{3,5}?", ["aaaa", "aa"]),
    (r"<.+?>", ["<a><b>", "<>"]),
    (r"(?:ab)+", ["abab", "aba", "b"]),
    (r"(?:a|bc)*d", ["abcbcad", "bd", "bcd", "b"]),
    (r"(a|b)*c", ["abac", "ab"]),
    (r"(?:)*", ["", "a"]),
    (r"()+", [""]),
    (r"(?:a*)*b", ["aab", "c"]),
    (r"(a*)+b", ["aab", "c"]),
    (r"(?:^a)?b", ["ab", "cb", "c"]),
    (r"a**", []),
    (r"a{2}{3}", []),
    (r"a*?+", []),
    (r"*a", []),
    (r"a|*", []),
    (r"^*", []),
    (r"\b+", []),
    (r"{1}", []),
    (r"x{2,1}", []),
    (r"(?i)*a", []),
    (r"a*+", ["aaa", "b"]),
    (r"a++", ["aaa", "b"]),
    (r"a?+", ["a", "b"]),
    (r"a{1,2}+", ["aa", "b"]),
    (r"(?=a)*b", ["b", "ab"]),
    # Groups and back-references.
    (r"(a)", ["a", "b"]),
    (r"(a)\1", ["aa", "ab"]),
    (r"(a)(b)\2\1", ["abba", "abab"]),
    (r"(?P<q>['\"]).*?(?P=q)", ['"x"', "'x\"", "x", "'x'"]),
    (r"(?P<a>x)(?P<b>y)(?P=b)(?P=a)", ["xyyx", "xyxy"]),
    (r"(?P<a_1>x)(?P=a_1)", ["xx", "x"]),
    (r"(a)(?:\1)*", ["aaaa", "a", "b"]),
    (r"(a)(b\1)", ["aba", "abb"]),
    (r"(a)(?=\1)", ["aa", "ab"]),
    (r"(a)(?!\1)", ["aa", "ab"]),
    (r"(a)(?:\1|b)", ["aa", "ab", "ac"]),
    (r"(?:(a)\1)+", ["aaaa", "aab", "a"]),
    (r"(a)(b)(c)(d)(e)(f)(g)(h)(i)(j)\10", ["abcdefghijj", "abcdefghija"]),
    (r"(a)(b)(c)(d)(e)(f)(g)(h)(i)(j)\1", ["abcdefghija"]),
    (r"(a)\1\060", ["aa0", "aa"]),
    (r"(?P<a>a)|b(?P=a)", ["b", "ba", "a"]),
    (r"(a)?\1", ["b", "aa", ""]),
    (r"(a)|\1", ["", "b", "a"]),
    (r"(?:(a)|b)+\1", ["abab", "aba", "bb"]),
    (r"(a)+\1", ["aa", "a"]),
    (r"(a|)+\1", ["b", "aa"]),
    (r"(a)\2", []),
    (r"(a\1)", []),
    (r"\1(a)", []),
    (r"(a)\10", []),
    (r"(?P<a>x)(?P<a>y)", []),
    (r"(?P=a)", []),
    (r"(?P<a>a(?P=a))", []),
    (r"(?P<1a>x)", []),
    (r"(?P<>x)", []),
    (r"(?P<a", []),
    (r"(?P<é>x)(?P=é)", ["xx", "x"]),
    (r"(?<a>x)", []),
    (r"(?P", []),
    (r"(?Px)", []),
    # Lookarounds.
    (r"(?=a)a", ["a", "b"]),
    (r"a(?=b)", ["ab", "ac"]),
    (r"a(?!b)", ["ab", "ac", "a"]),
    (r"(?<=a)b", ["ab", "cb", "b"]),
    (r"(?<!a)b", ["ab", "cb", "b"]),
    (r"(?<=ab|cd)x", ["abx", "cdx", "bx"]),
    (r"(?<=\d{3})x", ["123x", "12x", "١٢٣x"]),
    (r"(?<=😀)x", ["😀x", "x"]),
    (r"(?<=(a))b", ["ab", "b"]),
    (r"(?<=^a)b", ["ab", "cab"]),
    (r"(?<!^)a", ["a", "ba"]),
    (r"(?<=a(?=b))b", ["ab", "ac"]),
    (r"(?<=(?<!c)a)b", ["ab", "cab"]),
    (r"(?=)", ["", "a"]),
    (r"(?!)", ["", "a"]),
    (r"a(?=b|$)", ["ab", "a", "ac", "a\n"]),
    (r"(?<=a|bc)x", ["ax", "bcx"]),
    (r"(?<=a+)b", ["ab"]),
    (r"(?<=a*)b", ["ab"]),
    (r"(a)(?<=\1)", ["a"]),
    (r"(?<=(a)\1)b", []),
    # Global flags at the start.
    (r"(?i)abc", ["ABC", "aBc", "abd"]),
    (r"(?i)k", ["K", "k", _KELVIN, "x"]),
    (r"(?i)K", ["K", "k", _KELVIN]),
    (r"(?i)\u212a", ["k", "K", _KELVIN]),
    (r"(?i)s", [_LONG_S, "S", "s"]),
    (r"(?i)ſ", ["s", "S", _LONG_S]),
    (r"(?i)ß", ["ß", "ẞ", "SS", "ss"]),
    (r"(?i)ẞ", ["ß", "ẞ"]),
    (r"(?i)i", [_DOTTED_I, _DOTLESS_I, "I", "i"]),
    (r"(?i)I", [_DOTTED_I, _DOTLESS_I, "i"]),
    (r"(?i)İ", ["i", "I", _DOTTED_I, _DOTLESS_I]),
    (r"(?i)ı", ["i", "I", _DOTLESS_I, _DOTTED_I]),
    (r"(?i)σ", ["Σ", "ς", "σ"]),
    (r"(?i)µ", ["μ", "Μ", "µ"]),
    (r"(?i)ǅ", ["Ǆ", "ǆ", "ǅ", "D"]),
    (r"(?i)\u0345", ["ι", "Ι", "\u1fbe", "\u0345"]),
    (r"(?i)𐐀", ["𐐨", "𐐀"]),
    (r"(?i)pipe", ["PIPE", "PİPE", "PıPE", "pipe"]),
    (r"(?i)[a-z]+", [_DOTTED_I, _DOTLESS_I, "K", _KELVIN, _LONG_S, "ABC", "1"]),
    (r"(?i)[^a-z]", ["A", _KELVIN, _DOTTED_I, "1"]),
    (r"(?i)[k]", ["K", _KELVIN]),
    (r"(?i)[^k]", ["K", _KELVIN, "x"]),
    (r"(?i)[\w]", ["a", " ", "\u0345"]),
    (r"(?i)[\W]", ["a", " ", "\u0345"]),
    (r"(?i)[a\W]", ["A", " ", "b", "\u0345"]),
    (r"(?i)[^\W\d]", ["A", "1", _KELVIN]),
    (r"(?i)[\u00c0-\u00de]", ["é", "É", "ß", "ÿ"]),
    (r"(?i)a|\W", ["A", " ", "b"]),
    (r"(?i)[𐐀-𐐅]", ["𐐨", "𐐀"]),
    (r"(?i)(a)\1", ["aA", "ab"]),
    (r"(?i)^sensor", ["Sensor A", "SENSOR", "my sensor"]),
    (r"(?s)a.b", ["a\nb", "ab"]),
    (r"(?m)(?s)^a.b$", ["x\na\nb\ny", "ab"]),
    (r"(?im)^a$", ["x\nA\ny", "xA"]),
    (r"(?i)(?m)^b", ["a\nB", "aB"]),
    (r"(?si)A.B", ["a\nb", "ab"]),
    (r"(?ii)a", ["A"]),
    # Flags and extensions outside the subset.
    (r"(?x)a b", ["ab", "a b"]),
    (r"(?a)\w", ["é", "a"]),
    (r"(?u)\w", ["é"]),
    (r"(?L)a", []),
    (r"(?i:a)b", ["Ab", "AB"]),
    (r"(?-i:a)", ["a", "A"]),
    (r"a(?i)", []),
    (r"(?i)a|(?m)b", []),
    (r"(?z)", []),
    (r"(?#comment)a", ["a", "b"]),
    (r"(?>a)", ["a", "b"]),
    (r"(a)?(?(1)b|c)", ["ab", "c", "ac"]),
    (r"(?", []),
    (r"(", []),
    (r")", []),
    (r"a)", []),
    (r"((a)", []),
    # Alternation.
    (r"cat|dog", ["cat", "dog", "cow", "hotdog"]),
    (r"a|", ["", "b", *_ASTRAL]),
    (r"x|", ["", "x", "Ünïcødé " + _EMOJI, *_ASTRAL]),
    (r"|", [""]),
    (r"(?:a|ab)c", ["abc", "ac"]),
    (r"^(?:a|ab)$", ["ab", "a", "b"]),
    # What criteria tend to hold.
    (r"^Pump-\d{3}$", ["Pump-001", "Pump-٠٠١", "Pump-01", "Pump-001\n"]),
    (r"^[A-Z][a-z]+$", ["Sensor", "sensor", "Élan"]),
    (r"\.json$", ["a.json", "a.json\n", "a.jsonx"]),
    (r"^\s*$", ["", "  ", "\x1c", "\ufeff", "\xa0", "Café ☕ " + _EMOJI, *_ASTRAL]),
    (r"^\w+@\w+\.\w+$", ["a@b.c", "é@ü.ç", "a@b"]),
    (r"\$\d+(?:\.\d{2})?", ["$12.50", "$", "12"]),
    (r"^[^\s]+$", ["abc", "a c", "a\u3000c"]),
    (r"colou?r", ["color", "colour", "colr"]),
]

# Patterns matched against every code point (after the prefix), whole.
_CODE_POINT_CASES: list[tuple[str, str]] = [
    (r".", ""),
    (r"x?", ""),
    (r"\B", ""),
    (r"\w", ""),
    (r"\d", ""),
    (r"\s", ""),
    (r"[^\w\s]", ""),
    (r"a\b.", "a"),
    (r"(?i)k", ""),
    (r"(?i)i", ""),
    (r"(?i)[a-z]", ""),
    (r"(?i)[^a-z0-9]", ""),
    (r"(?i)[a\W]", ""),
    (r"(?i)[\u00c0-\u024f]", ""),
    (r"(?i)[\u0370-\u03ff]", ""),
]


def _case(pattern: str, subjects: list[str]) -> dict[str, Any]:
    try:
        re.compile(pattern)
    except re.error:
        return {"pattern": pattern, "error": True}
    return {
        "pattern": pattern,
        "subjects": [
            [s, re.search(pattern, s) is not None, re.fullmatch(pattern, s) is not None]
            for s in subjects
        ],
    }


def _accepted_ranges(pattern: str, prefix: str) -> list[int]:
    compiled = re.compile(pattern)
    out: list[int] = []
    for cp in range(sys.maxunicode + 1):
        if compiled.fullmatch(prefix + chr(cp)) is None:
            continue
        if out and out[-1] == cp - 1:
            out[-1] = cp
        else:
            out += [cp, cp]
    return out


@scenario("py_regex")
def py_regex() -> Any:
    with warnings.catch_warnings():
        warnings.simplefilter("ignore", FutureWarning)
        return {
            "cases": [_case(p, subjects) for p, subjects in _CASES],
            "code_points": [
                {"pattern": p, "prefix": prefix, "ranges": _accepted_ranges(p, prefix)}
                for p, prefix in _CODE_POINT_CASES
            ],
        }
