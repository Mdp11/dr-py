"""What ``parse_model_json`` makes of JSON text, kind by kind."""

from __future__ import annotations

from typing import Any

from data_rover.api.serialize import parse_model_json

from ..driver import scenario
from ..tagged import tag

_JSON_TEXTS = [
    "0", "-0", "1", "-17", "9007199254740991", "9007199254740992",
    "-9007199254740993", "123456789012345678901234567890",
    "1.0", "5.0", "-0.0", "1e5", "1E5", "1.5e-7", "1e400", "0.1",
    "Infinity", "-Infinity", "NaN", "[Infinity,-Infinity,NaN]",
    "true", "false", "null", '""', '"plain"',
    '"v2.1.1 contact1@org1.example 12:30.5"',
    '"esc \\" \\\\ \\/ \\b \\f \\n \\r \\t \\u00e9 \\ud83d\\ude00"',
    '"caf\u00e9 \u4e2d\u6587 \U0001f600"',
    "[]", "{}", "[1,2.0,[3,[4.5]]]",
    '{"a":1,"b":1.0,"c":{"d":[true,null]},"a2":"x"}',
    '{"k":1,"k":2}',
    '{"__proto__":{"x":1},"constructor":2}',
    ' { "spaced" : [ 1 , 2.5 ] , "n" : null } ',
    '{"id":"e_000001","type_name":"Sensor","properties":{"name":"S-1","ratio":0.25,'
    '"count":3,"big":12345678901234567890,"tags":["a","b"]},"rev":4}',
]  # fmt: skip


@scenario("json_parse")
def json_parse() -> Any:
    return [
        {"text": text, "value": tag(parse_model_json(text))} for text in _JSON_TEXTS
    ]
