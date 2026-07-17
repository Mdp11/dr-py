"""Shared host-side helpers for the CPython-WASI spike probes.

Spike code: favors print-and-measure over abstraction. Not production.

wasmtime-py 46.0.1 API notes (drift from the brief's original sketch, see
FINDINGS.md "API notes" for the full record):
  - There is no `StoreLimits` class in this version. `Store.set_limits()`
    takes the limit kwargs (`memory_size=`, `table_elements=`, ...) directly
    — call it as `store.set_limits(memory_size=mem_limit)`, not
    `store.set_limits(StoreLimits(memory_size=mem_limit))`.
  - `wasi.stdin_file` / `wasi.stdout_file` / `wasi.stderr_file` are plain
    write-only attributes, as in the brief.
  - `wasi.preopen_dir(path, guest_path)` matches the brief's call shape.
  - `Config.epoch_interruption` and `store.set_epoch_deadline(...)` match
    the brief.
  - `ExitTrap` exists with a `.code` attribute, as in the brief.
"""
from __future__ import annotations

import pathlib
import time

from wasmtime import Config, Engine, ExitTrap, Linker, Module, Store, WasiConfig

ROOT = pathlib.Path(__file__).parent
VENDOR = ROOT / "vendor"
PYTHON_WASM = VENDOR / "python.wasm"
GUEST_LIB_HOST = VENDOR / "lib" / "python3.14"  # contains encodings/ — NOT vendor/lib
GUEST_LIB_GUEST = "/lib"  # where the guest sees the stdlib


def make_engine(epoch: bool = False) -> tuple[Engine, Module]:
    cfg = Config()
    if epoch:
        cfg.epoch_interruption = True
    engine = Engine(cfg)
    t0 = time.perf_counter()
    module = Module.from_file(engine, str(PYTHON_WASM))
    print(f"[host] module compile: {time.perf_counter() - t0:.2f}s")
    return engine, module


def run_python(
    argv: list[str],
    *,
    stdin_file: str | None = None,
    stdout_file: str | None = None,
    env: tuple[tuple[str, str], ...] = (),
    preopens: tuple[tuple[str, str], ...] = (),
    epoch: bool = False,
    mem_limit: int | None = None,
    engine_module: tuple[Engine, Module] | None = None,
) -> tuple[int, float]:
    """Boot the guest interpreter with argv, run to completion, return (exit_code, seconds)."""
    engine, module = engine_module or make_engine(epoch=epoch)
    linker = Linker(engine)
    linker.define_wasi()
    store = Store(engine)
    if mem_limit is not None:
        store.set_limits(memory_size=mem_limit)
    if epoch:
        store.set_epoch_deadline(1)

    wasi = WasiConfig()
    wasi.argv = ["python"] + argv
    wasi.env = [("PYTHONHOME", GUEST_LIB_GUEST), ("PYTHONPATH", GUEST_LIB_GUEST)] + list(env)
    wasi.preopen_dir(str(GUEST_LIB_HOST), GUEST_LIB_GUEST)
    for host_path, guest_path in preopens:
        wasi.preopen_dir(host_path, guest_path)
    if stdin_file:
        wasi.stdin_file = stdin_file
    if stdout_file:
        wasi.stdout_file = stdout_file
    wasi.stderr_file = str(ROOT / "guest_stderr.log")
    store.set_wasi(wasi)

    instance = linker.instantiate(store, module)
    start = instance.exports(store)["_start"]
    t0 = time.perf_counter()
    try:
        start(store)
        code = 0
    except ExitTrap as e:
        code = e.code
    return code, time.perf_counter() - t0
