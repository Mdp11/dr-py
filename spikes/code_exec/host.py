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

from wasmtime import Config, Engine, ExitTrap, FuncType, Linker, Module, Store, ValType, WasiConfig

ROOT = pathlib.Path(__file__).parent
VENDOR = ROOT / "vendor"
PYTHON_WASM = VENDOR / "python.wasm"
GUEST_LIB_HOST = VENDOR / "lib" / "python3.14"  # contains encodings/ — NOT vendor/lib
GUEST_LIB_GUEST = "/lib"  # where the guest sees the stdlib

FIXED_NANOS = 1_750_000_000_000_000_000  # fixed wall-clock epoch (criterion 5, Task 7)


def _add_determinism_shims(linker: Linker, store: Store) -> None:
    """Shadow wasi_snapshot_preview1.clock_time_get/random_get with fixed values.

    wasmtime-py 46.0.1 confirmed API (see FINDINGS.md Task 7 section):
      - Linker.allow_shadowing is a write-only property; set True BEFORE
        linker.define_wasi() is called (see run_python below) — shadow-after
        (defining the shim funcs after define_wasi()) is what actually takes
        effect, matching the brief's predicted "last-wins" resolution order.
      - Linker.define_func(module, name, ty, func, access_caller=True) matches
        the brief verbatim.
      - The host callback receives a wasmtime.Caller as its first arg (because
        access_caller=True); caller.get("memory") returns the guest's
        exported Memory. Memory.write(store_like, value, start) accepts a
        Caller directly as the store-like argument (Storelike =
        Store | Caller | StoreContext in wasmtime._store) — no extra
        conversion needed, matching the brief's `mem.write(caller, bytes,
        offset)` call shape exactly.
    """
    i32, i64 = ValType.i32(), ValType.i64()

    def clock_time_get(caller, clock_id, precision, out_ptr):
        mem = caller.get("memory")
        # clock 0 = realtime -> fixed; others (monotonic) pass a counter so the interpreter can boot
        nanos = FIXED_NANOS if clock_id == 0 else int(time.perf_counter_ns())
        mem.write(caller, nanos.to_bytes(8, "little"), out_ptr)
        return 0

    def random_get(caller, buf, buf_len):
        mem = caller.get("memory")
        mem.write(caller, bytes([0x42]) * buf_len, buf)
        return 0

    linker.define_func(
        "wasi_snapshot_preview1",
        "clock_time_get",
        FuncType([i32, i64, i32], [i32]),
        clock_time_get,
        access_caller=True,
    )
    linker.define_func(
        "wasi_snapshot_preview1",
        "random_get",
        FuncType([i32, i32], [i32]),
        random_get,
        access_caller=True,
    )


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
    deterministic: bool = False,
) -> tuple[int, float]:
    """Boot the guest interpreter with argv, run to completion, return (exit_code, seconds).

    deterministic=True (Task 7, criterion 5) shadows the WASI clock/random
    imports with fixed values and forces PYTHONHASHSEED=0, so that identical
    guest code run twice produces byte-identical stdout. Default False keeps
    Tasks 1-6's probes unaffected.
    """
    engine, module = engine_module or make_engine(epoch=epoch)
    linker = Linker(engine)
    if deterministic:
        # Must be set before define_wasi() — see _add_determinism_shims'
        # docstring for why shadow-after (registering the shims after
        # define_wasi()) is the order that actually takes effect.
        linker.allow_shadowing = True
    linker.define_wasi()
    store = Store(engine)
    if deterministic:
        _add_determinism_shims(linker, store)
        env = tuple(env) + (("PYTHONHASHSEED", "0"),)
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
