from data_rover.api.table_cache import TableOrderCache, table_fingerprint


def test_put_get_roundtrip():
    c = TableOrderCache()
    fp = table_fingerprint('{"a":1}')
    c.put(fp, 5, (("x",), ("y",)), False, 2)
    assert c.get(fp, 5) == ((("x",), ("y",)), False, 2)


def test_truncated_flag_roundtrips():
    c = TableOrderCache()
    fp = table_fingerprint('{"a":1}')
    c.put(fp, 5, (("x",),), True, 1)
    assert c.get(fp, 5) == ((("x",),), True, 1)


def test_stale_rev_is_a_miss():
    c = TableOrderCache()
    fp = table_fingerprint('{"a":1}')
    c.put(fp, 5, (("x",),), False, 1)
    assert c.get(fp, 6) is None


def test_lru_evicts_beyond_cap():
    c = TableOrderCache(cap=2)
    for i in range(3):
        c.put(table_fingerprint(f'{{"a":{i}}}'), 1, ((str(i),),), False, 1)
    # oldest (i=0) evicted
    assert c.get(table_fingerprint('{"a":0}'), 1) is None
    assert c.get(table_fingerprint('{"a":2}'), 1) is not None


def test_fingerprint_differs_by_definition():
    # The sort lives IN the definition, so two sorts are two fingerprints.
    a = table_fingerprint('{"a":1,"sort":[]}')
    b = table_fingerprint('{"a":1,"sort":[{"column":0,"direction":"asc"}]}')
    assert a != b


def test_session_touch_model_clears_cache():
    from data_rover.api.session import Session

    s = Session()
    s.table_order_cache.put(table_fingerprint("{}"), 0, (("x",),), False, 1)
    s.touch_model()
    assert s.table_order_cache.get(table_fingerprint("{}"), 1) is None
