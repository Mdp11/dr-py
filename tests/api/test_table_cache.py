from data_rover.api.table_cache import TableOrderCache, table_fingerprint
from data_rover.core.table.evaluate import SortSpec


def test_put_get_roundtrip():
    c = TableOrderCache()
    fp = table_fingerprint('{"a":1}', None)
    c.put(fp, "none", 5, (("x",), ("y",)), False)
    assert c.get(fp, "none", 5) == ((("x",), ("y",)), False)


def test_truncated_flag_roundtrips():
    c = TableOrderCache()
    fp = table_fingerprint('{"a":1}', None)
    c.put(fp, "none", 5, (("x",),), True)
    assert c.get(fp, "none", 5) == ((("x",),), True)


def test_stale_rev_is_a_miss():
    c = TableOrderCache()
    fp = table_fingerprint('{"a":1}', None)
    c.put(fp, "none", 5, (("x",),), False)
    assert c.get(fp, "none", 6) is None


def test_lru_evicts_beyond_cap():
    c = TableOrderCache(cap=2)
    for i in range(3):
        c.put(table_fingerprint(f'{{"a":{i}}}', None), "none", 1, ((str(i),),), False)
    # oldest (i=0) evicted
    assert c.get(table_fingerprint('{"a":0}', None), "none", 1) is None
    assert c.get(table_fingerprint('{"a":2}', None), "none", 1) is not None


def test_fingerprint_differs_by_sort():
    a = table_fingerprint('{"a":1}', None)
    b = table_fingerprint('{"a":1}', SortSpec(column=0, direction="asc"))
    assert a != b


def test_session_touch_model_clears_cache():
    from data_rover.api.session import Session

    s = Session()
    s.table_order_cache.put(table_fingerprint("{}", None), "none", 0, (("x",),), False)
    s.touch_model()
    assert s.table_order_cache.get(table_fingerprint("{}", None), "none", 1) is None
