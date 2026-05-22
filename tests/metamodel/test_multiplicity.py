import pytest

from data_rover.metamodel.multiplicity import Multiplicity


def test_parse_exact():
    m = Multiplicity.parse("1")
    assert (m.lower, m.upper) == (1, 1)
    assert m.required is True
    assert m.is_single is True


def test_parse_optional_single():
    m = Multiplicity.parse("0..1")
    assert (m.lower, m.upper) == (0, 1)
    assert m.required is False
    assert m.is_single is True


def test_parse_optional_many():
    m = Multiplicity.parse("0..*")
    assert (m.lower, m.upper) == (0, None)
    assert m.is_single is False


def test_parse_required_many():
    m = Multiplicity.parse("1..*")
    assert (m.lower, m.upper) == (1, None)
    assert m.required is True


def test_count_in_range():
    m = Multiplicity.parse("1..*")
    assert m.count_ok(0) is False
    assert m.count_ok(1) is True
    assert m.count_ok(5) is True


def test_invalid_raises():
    with pytest.raises(ValueError):
        Multiplicity.parse("abc")
