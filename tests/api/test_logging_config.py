"""B-1: the app configures logging at create_app() so ``data_rover.*``
INFO records are actually emitted (previously they fell through to
``logging.lastResort``, which drops everything below WARNING)."""

from __future__ import annotations

import logging

from data_rover.api.main import _configure_logging


def test_configure_logging_installs_root_handler_when_absent() -> None:
    root = logging.getLogger()
    saved = root.handlers[:]
    root.handlers.clear()
    try:
        _configure_logging()
        assert root.handlers, "basicConfig must install a root handler"
    finally:
        root.handlers[:] = saved


def test_configure_logging_never_stomps_existing_root_handlers() -> None:
    # An operator-supplied config (or pytest's own capture handler) must
    # survive: basicConfig is a no-op when root already has handlers.
    root = logging.getLogger()
    saved = root.handlers[:]
    root.handlers.clear()
    marker = logging.NullHandler()
    root.addHandler(marker)
    try:
        _configure_logging()
        assert root.handlers == [marker]
    finally:
        root.handlers[:] = saved


def test_data_rover_logger_level_is_info() -> None:
    # Asserts .level, NOT isEnabledFor(): alembic's fileConfig
    # (test_alembic.py) sets .disabled on pre-existing loggers when it runs
    # earlier in the same session, which flips isEnabledFor() but not
    # .level — the same order-dependent hazard test_lock_mirror.py
    # documents. .level is what _configure_logging owns.
    _configure_logging()
    assert logging.getLogger("data_rover").level == logging.INFO
