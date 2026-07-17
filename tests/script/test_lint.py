from data_rover.core.script.lint import derive_entry_points, lint_code


def test_syntax_error_is_blocking_error():
    diags = lint_code("def value(el)\n  return 1")  # missing colon
    assert any(d.severity == "error" for d in diags)
    assert diags[0].line >= 1


def test_clean_code_no_errors():
    assert lint_code("value = lambda el: len(el.name)\n") == [] or all(
        d.severity == "warning" for d in lint_code("x = 1")
    )


def test_disallowed_import_is_warning():
    diags = lint_code("import os\n")
    assert any(d.severity == "warning" and "os" in d.message for d in diags)
    assert all(d.severity != "error" for d in diags)  # not blocking


def test_allowed_import_ok():
    assert lint_code("import re\nvalue = lambda el: re.findall('a', el.name)") == []


def test_unknown_name_is_warning():
    diags = lint_code("y = undefined_name + 1\n")
    assert any(d.severity == "warning" and "undefined_name" in d.message for d in diags)


def test_dr_names_are_known():
    assert lint_code("rows = list(dr.elements())\n") == []


def test_entry_points_derived():
    assert set(derive_entry_points("def value(el):\n    return 1\n")) == {"script", "value"}
    assert set(derive_entry_points("def step(el):\n    return []\n")) == {"script", "step"}
    both = derive_entry_points("def value(el):\n    return 1\ndef step(el):\n    return []\n")
    assert set(both) == {"script", "value", "step"}
    assert derive_entry_points("x = (") == []  # unparseable


def test_bad_entry_signature_is_warning():
    diags = lint_code("def value(a, b):\n    return 1\n")
    assert any(d.severity == "warning" and "value" in d.message for d in diags)


def test_except_binding_is_known():
    code = "try:\n    x = 1\nexcept Exception as e:\n    print(e)\n"
    assert lint_code(code) == []
