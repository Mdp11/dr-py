from data_rover.migration.legacy import infer_datatype


def test_all_integers():
    assert infer_datatype([1, 2, 3]) == "integer"


def test_all_floats():
    assert infer_datatype([1.5, 2.0]) == "float"


def test_mixed_int_and_float_is_float():
    assert infer_datatype([1, 2.5]) == "float"


def test_booleans_not_treated_as_integers():
    assert infer_datatype([True, False]) == "boolean"


def test_iso_date_strings():
    assert infer_datatype(["2024-01-02", "2024-12-31"]) == "date"


def test_plain_strings():
    assert infer_datatype(["a", "hello"]) == "string"


def test_mixed_types_fall_back_to_string():
    assert infer_datatype([1, "a"]) == "string"


def test_no_values_defaults_to_string():
    assert infer_datatype([]) == "string"


def test_nulls_ignored():
    assert infer_datatype([None, 1, None]) == "integer"
