from data_rover.core.script.runner import RunLimits, RunRequest
from tests.script.trusted_runner import TrustedRunner
from tests.script.conftest import tiny_model


def test_standalone_prints_and_reads():
    r = TrustedRunner()
    res = r.run(tiny_model(),
                RunRequest(code="els = list(dr.elements())\nprint(len(els))\nresult = len(els)"),
                RunLimits(), record_ops=False, rev=0)
    assert res.error is None
    assert res.stdout.strip() == "3"
    assert res.result_repr == "3"


def test_value_entry_receives_single_element_as_list():
    r = TrustedRunner()
    res = r.run(tiny_model(),
                RunRequest(code="def value(elements):\n    return [e.id for e in elements]",
                           entry="value", element_ids=["b1"]),
                RunLimits(), record_ops=False, rev=0)
    assert res.error is None, res.error
    assert res.result_repr == "['b1']"


def test_value_entry_receives_elements_in_bound_order():
    r = TrustedRunner()
    res = r.run(tiny_model(),
                RunRequest(code="def value(elements):\n    return [e.name for e in elements]",
                           entry="value", element_ids=["b2", "b1"]),
                RunLimits(), record_ops=False, rev=0)
    assert res.error is None, res.error
    assert res.result_repr == "['Building Two', 'Building One']"


def test_value_entry_unknown_id_is_runtime_error():
    r = TrustedRunner()
    res = r.run(tiny_model(),
                RunRequest(code="def value(elements):\n    return 1",
                           entry="value", element_ids=["nope"]),
                RunLimits(), record_ops=False, rev=0)
    assert res.error is not None and res.error.kind == "runtime"  # dr.NotFoundError surfaced


def test_step_entry_receives_single_element():
    r = TrustedRunner()
    res = r.run(tiny_model(),
                RunRequest(code="def step(el):\n    return el.id",
                           entry="step", element_ids=["b1"]),
                RunLimits(), record_ops=False, rev=0)
    assert res.error is None, res.error
    assert res.result_repr == "'b1'"


def test_write_recorded_as_op_not_applied():
    m = tiny_model()
    r = TrustedRunner()
    res = r.run(m, RunRequest(code="dr.element('b1').delete()"), RunLimits(), record_ops=True, rev=0)
    assert res.error is None
    assert res.ops == [{"kind": "delete_element", "id": "b1"}]
    assert "b1" in m.elements  # NOT applied


def test_write_blocked_in_readonly_context():
    r = TrustedRunner()
    res = r.run(tiny_model(), RunRequest(code="dr.element('b1').delete()"), RunLimits(), record_ops=False, rev=0)
    assert res.error is not None and res.error.kind == "runtime"  # dr.ReadOnlyError surfaced


def test_stdout_truncation():
    r = TrustedRunner()
    res = r.run(tiny_model(), RunRequest(code="print('x' * 10)"), RunLimits(stdout_bytes=4), record_ops=False, rev=0)
    assert res.truncated and len(res.stdout) <= 8  # cap + ellipsis slack


# --- additional coverage beyond the brief's 5 tests -------------------------


def test_element_attrs_indexing_and_props():
    r = TrustedRunner()
    code = (
        "el = dr.element('b1')\n"
        "result = (el.id, el.stereotype, el.name, el['name'], el.get('name'), "
        "el.get('missing', 'dflt'), el.props())\n"
    )
    res = r.run(tiny_model(), RunRequest(code=code), RunLimits(), record_ops=False, rev=0)
    assert res.error is None
    assert res.result_repr == (
        "('b1', 'Building', 'Building One', 'Building One', 'Building One', "
        "'dflt', {'name': 'Building One'})"
    )


def test_out_in_parent_children():
    r = TrustedRunner()
    code = (
        "b1 = dr.element('b1')\n"
        "b2 = dr.element('b2')\n"
        "b3 = dr.element('b3')\n"
        "result = (\n"
        "    [rel['type'] for rel in b1.out()],\n"
        "    [rel['type'] for rel in b2.in_()],\n"
        "    b2.parent().id,\n"
        "    b3.parent(),\n"
        "    [c.id for c in b1.children()],\n"
        "    b3.children(),\n"
        ")\n"
    )
    res = r.run(tiny_model(), RunRequest(code=code), RunLimits(), record_ops=False, rev=0)
    assert res.error is None
    assert res.result_repr == "(['Owns'], ['Owns'], 'b1', None, ['b2'], [])"


def test_create_connect_disconnect_set_op_shapes():
    m = tiny_model()
    r = TrustedRunner()
    code = (
        "eid = dr.create('Building', properties={'name': 'New'})\n"
        "rid = dr.connect('Owns', 'b1', 'b3')\n"
        "dr.disconnect('some-rel-id')\n"
        "dr.element('b2').set('name', 'Renamed')\n"
        "result = (eid, rid)\n"
    )
    res = r.run(m, RunRequest(code=code), RunLimits(), record_ops=True, rev=0)
    assert res.error is None
    assert res.ops == [
        {
            "kind": "create_element",
            "temp_id": "tmp_1",
            "type_name": "Building",
            "properties": {"name": "New"},
        },
        {
            "kind": "create_relationship",
            "temp_id": "tmp_2",
            "type_name": "Owns",
            "source_id": "b1",
            "target_id": "b3",
            "properties": {},
        },
        {"kind": "delete_relationship", "id": "some-rel-id"},
        {
            "kind": "update_element",
            "id": "b2",
            "properties_patch": {"name": "Renamed"},
        },
    ]
    assert res.result_repr == "('tmp_1', 'tmp_2')"


def test_not_found_error_on_missing_element():
    r = TrustedRunner()
    res = r.run(tiny_model(), RunRequest(code="dr.element('nope')"), RunLimits(), record_ops=False, rev=0)
    assert res.error is not None and res.error.kind == "runtime"
    assert "NotFoundError" in (res.error.traceback or res.error.message)


def test_traceback_line_numbers_are_the_snippet_s_own():
    """A raise on line 3 of a 3-line snippet reports line 3 — not line 3 +
    len(FACADE_SOURCE). The facade is its own compilation unit precisely so a
    snippet author's traceback matches what the editor shows them."""
    r = TrustedRunner()
    res = r.run(tiny_model(),
                RunRequest(code="x = 1\ny = 2\nraise ValueError('boom')"),
                RunLimits(), record_ops=False, rev=0)
    assert res.error is not None and res.error.kind == "runtime"
    assert 'File "<snippet>", line 3' in (res.error.traceback or "")
    assert "<facade>" not in (res.error.traceback or "")


def test_syntax_error_line_number_is_the_snippet_s_own():
    r = TrustedRunner()
    res = r.run(tiny_model(),
                RunRequest(code="x = 1\ndef (:\n"),
                RunLimits(), record_ops=False, rev=0)
    assert res.error is not None and res.error.kind == "syntax"
    assert "line 2" in res.error.message


def test_element_stereotype_property_and_repr():
    r = TrustedRunner()
    res = r.run(tiny_model(),
                RunRequest(code="el = dr.element('b1')\nresult = (el.stereotype, repr(el))"),
                RunLimits(), record_ops=False, rev=0)
    assert res.error is None, res.error
    assert res.result_repr == "('Building', \"Element(id='b1', stereotype='Building')\")"


def test_element_type_attribute_is_gone():
    r = TrustedRunner()
    res = r.run(tiny_model(),
                RunRequest(code="result = dr.element('b1').type"),
                RunLimits(), record_ops=False, rev=0)
    assert res.error is not None and res.error.kind == "runtime"


def test_elements_accepts_stereotypes_list():
    r = TrustedRunner()
    res = r.run(tiny_model(),
                RunRequest(code="result = sorted(e.id for e in dr.elements(stereotypes=['Building']))"),
                RunLimits(), record_ops=False, rev=0)
    assert res.error is None, res.error
    assert res.result_repr == "['b1', 'b2', 'b3']"


def test_elements_accepts_single_stereotype_string():
    r = TrustedRunner()
    res = r.run(tiny_model(),
                RunRequest(code="result = len(list(dr.elements(stereotypes='Building')))"),
                RunLimits(), record_ops=False, rev=0)
    assert res.error is None, res.error
    assert res.result_repr == "3"


def test_dr_types_and_dr_type_are_gone():
    r = TrustedRunner()
    res = r.run(tiny_model(), RunRequest(code="result = dr.types()"),
                RunLimits(), record_ops=False, rev=0)
    assert res.error is not None and res.error.kind == "runtime"
    res = r.run(tiny_model(), RunRequest(code="result = dr.type('Building')"),
                RunLimits(), record_ops=False, rev=0)
    assert res.error is not None and res.error.kind == "runtime"
