import pytest
from pydantic import ValidationError

from data_rover.core.script.schema import SNIPPET_ADAPTER, SnippetDefinition


def test_minimal_snippet_validates():
    d = SNIPPET_ADAPTER.validate_python({"code": "x = 1"})
    assert isinstance(d, SnippetDefinition)
    assert d.schema_version == 1 and d.language == "python"
    assert d.entry_points == []  # default; derived separately, not trusted here


def test_non_python_language_rejected():
    with pytest.raises(ValidationError):
        SNIPPET_ADAPTER.validate_python({"code": "x=1", "language": "ruby"})


def test_oversize_code_rejected():
    from data_rover.core.script.schema import SNIPPET_MAX_CODE_BYTES
    with pytest.raises(ValidationError):
        SNIPPET_ADAPTER.validate_python({"code": "x" * (SNIPPET_MAX_CODE_BYTES + 1)})
