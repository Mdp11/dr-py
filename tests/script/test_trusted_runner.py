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


def test_outgoing_incoming_parent_children():
    r = TrustedRunner()
    code = (
        "b1 = dr.element('b1')\n"
        "b2 = dr.element('b2')\n"
        "b3 = dr.element('b3')\n"
        "result = (\n"
        "    [rel.stereotype for rel in b1.outgoing()],\n"
        "    [rel.stereotype for rel in b2.incoming()],\n"
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


def test_create_temp_id_not_resolvable_via_element():
    # dr.create is a recorded op, never applied to the model this run reads
    # against -- so the temp id it returns is usable as a source_id/target_id
    # in dr.connect(), but dr.element() on it is a plain miss. Pins the
    # facade_src.py `_create` docstring's corrected claim.
    m = tiny_model()
    r = TrustedRunner()
    code = (
        "tid = dr.create('Building', properties={'name': 'New'})\n"
        "dr.element(tid)\n"
    )
    res = r.run(m, RunRequest(code=code), RunLimits(), record_ops=True, rev=0)
    assert res.error is not None and res.error.kind == "runtime"
    assert "NotFoundError" in (res.error.traceback or res.error.message)


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
    # Assert on the message too, not just the kind: a `runtime` error alone
    # would also be produced if `dr.element` itself regressed, so the bare
    # kind check could pass green while proving nothing about the removal.
    assert res.error is not None and res.error.kind == "runtime"
    assert "AttributeError" in res.error.message, res.error.message
    # Name the RECEIVER, not just the attribute: a regression where
    # `dr.element` returned None would still raise AttributeError mentioning
    # `type` ("'NoneType' object has no attribute 'type'"), so only pinning
    # `Element` proves the lookup reached a real Element and failed there.
    assert "'Element' object has no attribute 'type'" in res.error.message, (
        res.error.message
    )


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
    # Message, not just kind — see test_element_type_attribute_is_gone.
    assert res.error is not None and res.error.kind == "runtime"
    assert "AttributeError" in res.error.message, res.error.message
    assert "types" in res.error.message
    res = r.run(tiny_model(), RunRequest(code="result = dr.type('Building')"),
                RunLimits(), record_ops=False, rev=0)
    # `type` is no longer an attribute of `_Dr` at all, so the failure is the
    # attribute lookup itself (AttributeError), never a call-time TypeError.
    assert res.error is not None and res.error.kind == "runtime"
    assert "AttributeError" in res.error.message, res.error.message
    assert "'type'" in res.error.message


# --- Task 5: Relationship class, outgoing()/incoming() filters, expected= ----


def test_outgoing_returns_relationship_objects():
    r = TrustedRunner()
    res = r.run(tiny_model(),
                RunRequest(code=(
                    "rel = dr.element('b1').outgoing()[0]\n"
                    "result = (rel.stereotype, rel.source().id, rel.destination().id)"
                )),
                RunLimits(), record_ops=False, rev=0)
    assert res.error is None, res.error
    assert res.result_repr == "('Owns', 'b1', 'b2')"


def test_relationship_get_props_and_getitem():
    r = TrustedRunner()
    res = r.run(tiny_model(),
                RunRequest(code=(
                    "rel = dr.element('b1').outgoing()[0]\n"
                    "result = (rel.get('missing', 'dflt'), rel.props())"
                )),
                RunLimits(), record_ops=False, rev=0)
    assert res.error is None, res.error
    assert res.result_repr == "('dflt', {})"


def test_relationship_id_and_repr():
    r = TrustedRunner()
    res = r.run(tiny_model(),
                RunRequest(code=(
                    "rel = dr.element('b1').outgoing()[0]\n"
                    "result = (rel.id == rel._data['id'], repr(rel))"
                )),
                RunLimits(), record_ops=False, rev=0)
    assert res.error is None, res.error
    assert res.result_repr is not None
    assert res.result_repr.startswith("(True, \"Relationship(id=")
    assert "stereotype='Owns')\"" in res.result_repr


def test_relationship_getitem_raises_on_missing_property():
    r = TrustedRunner()
    res = r.run(tiny_model(),
                RunRequest(code="result = dr.element('b1').outgoing()[0]['nope']"),
                RunLimits(), record_ops=False, rev=0)
    assert res.error is not None and res.error.kind == "runtime"
    assert "KeyError" in (res.error.traceback or res.error.message)


def test_old_hop_names_are_gone():
    r = TrustedRunner()
    for code, name in (("dr.element('b1').out()", "out"),
                       ("dr.element('b1').in_()", "in_")):
        res = r.run(tiny_model(), RunRequest(code="result = " + code),
                    RunLimits(), record_ops=False, rev=0)
        # Message, not just kind — see test_element_type_attribute_is_gone.
        assert res.error is not None and res.error.kind == "runtime"
        assert "AttributeError" in res.error.message, res.error.message
        assert repr(name) in res.error.message, res.error.message


def test_hop_filter_by_relationship_stereotype():
    r = TrustedRunner()
    res = r.run(tiny_model(),
                RunRequest(code=(
                    "el = dr.element('b1')\n"
                    "result = (len(el.outgoing(stereotype='Owns')),\n"
                    "          len(el.outgoing(stereotype=['Owns'])))"
                )),
                RunLimits(), record_ops=False, rev=0)
    assert res.error is None, res.error
    # tiny_model() has exactly one Owns rel out of b1; str and list filter
    # forms must agree.
    assert res.result_repr == "(1, 1)"


def test_hop_filter_unknown_stereotype_raises_notfound():
    r = TrustedRunner()
    res = r.run(tiny_model(),
                RunRequest(code="result = dr.element('b1').outgoing(stereotype='Nope')"),
                RunLimits(), record_ops=False, rev=0)
    assert res.error is not None and res.error.kind == "runtime"
    assert "NotFoundError" in res.error.message


def test_hop_filter_by_other_stereotype():
    r = TrustedRunner()
    res = r.run(tiny_model(),
                RunRequest(code=(
                    "el = dr.element('b1')\n"
                    "result = (len(el.outgoing(other_stereotype='Building')),\n"
                    "          len(el.incoming(other_stereotype='Building')))"
                )),
                RunLimits(), record_ops=False, rev=0)
    assert res.error is None, res.error
    assert res.result_repr == "(1, 0)"


def test_incoming_returns_relationships_and_filters():
    r = TrustedRunner()
    res = r.run(tiny_model(),
                RunRequest(code=(
                    "rel = dr.element('b2').incoming(stereotype='Owns', expected=1)\n"
                    "result = (rel.source().id, rel.destination().id,\n"
                    "          len(dr.element('b2').incoming(other_stereotype='Building')))"
                )),
                RunLimits(), record_ops=False, rev=0)
    assert res.error is None, res.error
    assert res.result_repr == "('b1', 'b2', 1)"


def test_expected_returns_single_relationship():
    r = TrustedRunner()
    res = r.run(tiny_model(),
                RunRequest(code=(
                    "rel = dr.element('b1').outgoing(expected=1)\n"
                    "result = rel.destination().id"
                )),
                RunLimits(), record_ops=False, rev=0)
    assert res.error is None, res.error
    assert res.result_repr == "'b2'"


def test_expected_mismatch_is_informative_cardinality_error():
    r = TrustedRunner()
    res = r.run(tiny_model(),
                RunRequest(code="dr.element('b3').outgoing(expected=1)"),
                RunLimits(), record_ops=False, rev=0)
    assert res.error is not None and res.error.kind == "runtime"
    assert "CardinalityError" in res.error.message
    assert "'b3'" in res.error.message
    assert "outgoing" in res.error.message
    assert "expected 1" in res.error.message


def test_expected_mismatch_message_names_active_filters():
    r = TrustedRunner()
    res = r.run(tiny_model(),
                RunRequest(code="dr.element('b3').outgoing(stereotype='Owns', expected=2)"),
                RunLimits(), record_ops=False, rev=0)
    assert res.error is not None
    assert "stereotype='Owns'" in res.error.message
    assert "expected 2" in res.error.message


def test_expected_invalid_values_raise_valueerror():
    r = TrustedRunner()
    for bad in ("0", "-1", "True", "'1'"):
        res = r.run(tiny_model(),
                    RunRequest(code="dr.element('b1').outgoing(expected=%s)" % bad),
                    RunLimits(), record_ops=False, rev=0)
        assert res.error is not None and res.error.kind == "runtime", bad
        assert "ValueError" in res.error.message, bad


def test_expected_check_applies_to_filtered_count():
    # b1 has 1 outgoing rel; filtered to a stereotype that matches it,
    # expected=1 passes even though an unfiltered expected=2 would fail.
    r = TrustedRunner()
    res = r.run(tiny_model(),
                RunRequest(code=(
                    "rel = dr.element('b1').outgoing(stereotype='Owns', expected=1)\n"
                    "result = rel.id is not None"
                )),
                RunLimits(), record_ops=False, rev=0)
    assert res.error is None, res.error
    assert res.result_repr == "True"


def test_cardinality_error_is_catchable_via_dr_alias():
    r = TrustedRunner()
    res = r.run(tiny_model(),
                RunRequest(code=(
                    "try:\n"
                    "    dr.element('b3').outgoing(expected=1)\n"
                    "    result = 'no-raise'\n"
                    "except dr.CardinalityError:\n"
                    "    result = 'caught'\n"
                )),
                RunLimits(), record_ops=False, rev=0)
    assert res.error is None, res.error
    assert res.result_repr == "'caught'"


def test_relationship_mutation_cannot_poison_memo():
    # Mirrors the Element memo-aliasing tests: mutating what a hop returned
    # must not change what a later identical hop returns.
    r = TrustedRunner()
    res = r.run(tiny_model(),
                RunRequest(code=(
                    "el = dr.element('b1')\n"
                    "first = el.outgoing()[0]\n"
                    "first.props()['injected'] = True\n"
                    "second = el.outgoing()[0]\n"
                    "result = second.get('injected') is None"
                )),
                RunLimits(), record_ops=False, rev=0)
    assert res.error is None, res.error
    assert res.result_repr == "True"


def test_relationship_does_not_alias_list_valued_property_in_memo():
    """The REAL memo-aliasing probe for Relationship.

    `props()` already returns a `dict(...)` copy, so mutating it can never
    reach `_memo` whether or not the hop copies — that test pins the API, not
    the invariant. The load-bearing case is a LIST-VALUED relationship
    property reached through `rel[key]`: without `_copy_projection` in the
    hop, `rel['tags'].append(...)` mutates the memo's own relationship dict
    and a later identical hop observes the injected value.
    """
    from data_rover.core.metamodel.schema import (
        ElementType,
        Metamodel,
        PropertyDef,
        RelationshipType,
    )
    from data_rover.core.model.model import Model

    mm = Metamodel(
        elements=[
            ElementType(name="Building", properties=[PropertyDef(name="name", datatype="string")]),
        ],
        relationships=[
            RelationshipType(
                name="Owns",
                containment=True,
                source="Building",
                target="Building",
                properties=[
                    PropertyDef(name="tags", datatype="string", multiplicity="0..*")
                ],
            ),
        ],
    )
    model = Model(mm)
    model.restore_element("b1", "Building")
    model.restore_element("b2", "Building")
    rel = model.connect("Owns", "b1", "b2")
    model.set_property(rel, "tags", ["a", "b"])

    r = TrustedRunner()
    res = r.run(model,
                RunRequest(code=(
                    "el = dr.element('b1')\n"
                    "first = el.outgoing()[0]\n"
                    "first['tags'].append('junk')\n"
                    "second = el.outgoing()[0]\n"
                    "result = len(second['tags'])\n"
                )),
                RunLimits(), record_ops=False, rev=0)
    assert res.error is None, res.error
    assert res.result_repr == "2"


# --- Fix wave: inheritance-aware hop filters + dangling far-endpoint skip ---
# (closes two coverage gaps a reviewer found in Task 5's test suite: see
# .superpowers/sdd/task-5-report.md's "Fix wave" section for the writeup.)


def _inheritance_model():
    """A model with a real `extends` hierarchy on BOTH axes -- an element
    supertype/subtype pair (`Asset` / `Building`) and a relationship
    supertype/subtype pair (`Association` / `Owns`) -- which `tiny_model()`
    cannot express (its lone `Building` element type and `Owns` relationship
    type have no subtypes). Every existing stereotype-filter test in this
    file filters by an exact, subtype-less name, so none of them can catch
    `_stereotype_filter` degrading to plain exact-name matching; this
    fixture is what makes that regression visible.
    """
    from data_rover.core.metamodel.schema import (
        ElementType,
        Metamodel,
        PropertyDef,
        RelationshipType,
    )
    from data_rover.core.model.model import Model

    mm = Metamodel(
        elements=[
            ElementType(
                name="Asset",
                abstract=True,
                properties=[PropertyDef(name="name", datatype="string")],
            ),
            ElementType(name="Building", extends="Asset"),
        ],
        relationships=[
            RelationshipType(name="Association", abstract=True),
            RelationshipType(
                name="Owns",
                extends="Association",
                source="Building",
                target="Building",
            ),
        ],
    )
    model = Model(mm)
    s1 = model.restore_element("s1", "Building")
    s2 = model.restore_element("s2", "Building")
    model.set_property(s1, "name", "S1")
    model.set_property(s2, "name", "S2")
    model.connect("Owns", "s1", "s2")
    return model


def test_hop_stereotype_filter_matches_subtype_of_named_supertype():
    """`stereotype='Association'` (the SUPERtype) must match an actual
    `Owns` (SUBtype) relationship -- both filters are documented as
    inheritance-aware over the relationship-type hierarchy."""
    r = TrustedRunner()
    res = r.run(_inheritance_model(),
                RunRequest(code=(
                    "rel = dr.element('s1').outgoing(stereotype='Association', expected=1)\n"
                    "result = rel.stereotype"
                )),
                RunLimits(), record_ops=False, rev=0)
    assert res.error is None, res.error
    assert res.result_repr == "'Owns'"


def test_hop_other_stereotype_filter_matches_subtype_of_named_supertype():
    """`other_stereotype='Asset'` (the SUPERtype) must match a far endpoint
    that is actually a `Building` (SUBtype) -- filters are documented as
    inheritance-aware over the element-type hierarchy too."""
    r = TrustedRunner()
    res = r.run(_inheritance_model(),
                RunRequest(code=(
                    "rel = dr.element('s1').outgoing(other_stereotype='Asset', expected=1)\n"
                    "result = rel.destination().id"
                )),
                RunLimits(), record_ops=False, rev=0)
    assert res.error is None, res.error
    assert res.result_repr == "'s2'"


def test_hop_other_stereotype_filter_skips_dangling_far_endpoint():
    """A relationship whose far endpoint element no longer exists is treated
    as NON-MATCHING under `other_stereotype` and silently skipped -- never
    raising `NotFoundError`. The engine deliberately stays inspectable on
    non-conformant data (see `facade_src.py`'s `_hop`, the `try/except
    NotFoundError` around its `_fetch_element(far_id)` call).

    The dangling relationship cannot be built through `Model`'s mutation
    boundary: `connect`/`restore_relationship` both require the target
    element to already exist, and `delete_element` cascades to clean up any
    relationship still touching a deleted element. So this uses the
    documented bulk-loader path instead (`Model`'s class docstring: "Bulk
    loaders that populate the dicts directly must call indexes.rebuild()"),
    the same pattern
    `tests/model/test_indexes.py::test_rebuild_after_direct_population` uses.
    """
    from data_rover.core.model.relationship import Relationship

    model = tiny_model()
    model.relationships["dangling"] = Relationship(
        id="dangling", type_name="Owns", source_id="b1", target_id="ghost",
    )
    model.indexes.rebuild()

    r = TrustedRunner()
    res = r.run(model,
                RunRequest(code=(
                    "el = dr.element('b1')\n"
                    "unfiltered = el.outgoing()\n"
                    "filtered = el.outgoing(other_stereotype='Building')\n"
                    "result = (len(unfiltered), sorted(rel.destination().id for rel in filtered))\n"
                )),
                RunLimits(), record_ops=False, rev=0)
    assert res.error is None, res.error
    # b1 has 2 outgoing rels (the real one to b2, plus the dangling one to
    # 'ghost'); the other_stereotype filter must silently skip the dangling
    # one rather than raising when it tries to resolve 'ghost'.
    assert res.result_repr == "(2, ['b2'])"


# --- read-only snippets must never be able to mutate the session model -------


def _multi_valued_model():
    """tiny_model()'s shape plus a LIST-valued `tags` property on `b1` (and on
    the `Owns` relationship), so a projection carries a mutable container.

    A dedicated metamodel is needed because `Model.set_property` rejects a
    property the element type does not declare — the conftest metamodel only
    declares the scalar `name`.
    """
    from data_rover.core.metamodel.schema import (
        ElementType,
        Metamodel,
        PropertyDef,
        RelationshipType,
    )
    from data_rover.core.model.model import Model

    mm = Metamodel(
        elements=[
            ElementType(
                name="Building",
                properties=[
                    PropertyDef(name="name", datatype="string"),
                    PropertyDef(name="tags", datatype="string", multiplicity="0..*"),
                ],
            ),
        ],
        relationships=[
            RelationshipType(
                name="Owns",
                containment=True,
                source="Building",
                target="Building",
                properties=[
                    PropertyDef(name="tags", datatype="string", multiplicity="0..*"),
                ],
            ),
        ],
    )
    model = Model(mm)
    b1 = model.restore_element("b1", "Building")
    model.restore_element("b2", "Building")
    model.set_property(b1, "name", "Building One")
    model.set_property(b1, "tags", ["a", "b"])
    rel = model.connect("Owns", "b1", "b2")
    model.set_property(rel, "tags", ["r1"])
    return model


def test_scan_cannot_mutate_list_valued_property_of_live_model():
    """`bridge.py`'s headline invariant: "a snippet that only reads never needs
    a lock and can never corrupt the session's model".

    `TrustedRunner` binds the guest transport straight to
    `BridgeDispatcher.dispatch` with no JSON boundary, so a projection that
    only shallow-copied the property bag would hand snippet code the core
    `Element`'s OWN list — and `el['tags'].append(...)` in a read-only scan
    would edit the session model in place. Host-side `_copy_properties` is
    what makes this impossible for both runners.
    """
    model = _multi_valued_model()
    r = TrustedRunner()
    res = r.run(model,
                RunRequest(code=(
                    "for el in dr.elements():\n"
                    "    el.props()\n"
                    "    try:\n"
                    "        el['tags'].append('POISON')\n"
                    "    except KeyError:\n"
                    "        pass\n"
                    "result = 'done'\n"
                )),
                RunLimits(), record_ops=False, rev=0)
    assert res.error is None, res.error
    assert res.result_repr == "'done'"
    assert model.elements["b1"].properties["tags"] == ["a", "b"]


def test_hop_and_fetch_cannot_mutate_list_valued_properties_of_live_model():
    """Same invariant across the non-scan read paths: a single-element fetch
    and a relationship hop (whose response also inlines the far endpoint).

    Unlike the scan case above, these paths are ALSO defended guest-side by
    `_copy_projection`, so this test stays green even with the host-side
    `_copy_properties` removed — it pins the invariant, not that one fix.
    Do not read it as coverage for `bridge._copy_properties`.
    """
    model = _multi_valued_model()
    r = TrustedRunner()
    res = r.run(model,
                RunRequest(code=(
                    "el = dr.element('b1')\n"
                    "el['tags'].append('POISON')\n"
                    "rel = el.outgoing()[0]\n"
                    "rel['tags'].append('POISON')\n"
                    "for child in el.children():\n"
                    "    child.props()\n"
                    "result = 'done'\n"
                )),
                RunLimits(), record_ops=False, rev=0)
    assert res.error is None, res.error
    assert model.elements["b1"].properties["tags"] == ["a", "b"]
    assert [r_.properties["tags"] for r_ in model.relationships.values()] == [["r1"]]
