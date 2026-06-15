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


def test_integer_strings():
    assert infer_datatype(["5", "10", "-3"]) == "integer"


def test_float_strings():
    assert infer_datatype(["2.5", "3.0", "-0.25"]) == "float"


def test_mixed_int_and_float_strings_is_float():
    assert infer_datatype(["5", "2.5"]) == "float"


def test_mixed_native_and_string_numbers_is_float():
    assert infer_datatype([5, "2.5"]) == "float"


def test_numeric_and_plain_string_falls_back_to_string():
    assert infer_datatype(["5", "abc"]) == "string"


def test_infinity_tokens_are_float():
    # "Infinity"/"-Infinity" are the canonical special float values.
    assert infer_datatype(["Infinity", "-Infinity"]) == "float"
    assert infer_datatype(["2.5", "Infinity"]) == "float"


def test_non_canonical_infinity_and_nan_stay_string():
    # only the exact "Infinity"/"-Infinity" tokens are special float values;
    # other non-finite spellings cannot be represented in JSON, so they stay
    # plain strings.
    assert infer_datatype(["inf", "-inf"]) == "string"
    assert infer_datatype(["nan", "NaN"]) == "string"
    assert infer_datatype(["Infinity", "inf"]) == "string"  # mix -> string
