"""Shared table-export engine: the 202-vs-ship logic behind
`POST /tables/export` and `POST /exports/run`.

Both `POST /tables/export` and `POST /exports/run` share ONE completeness
probe, ONE decision table, ONE zip builder here. The FIX A / FIX B comments
below are load-bearing; do not trim them.

`run_table_export` takes TWO definitions: `defn` (evaluation — always the
original) and `render_defn` (presentation — an `overridden_table` copy for
an exporter entry, the same object otherwise). This is the RENDER ONLY
boundary from `core/table/export_layout.py` made into a parameter.
"""

from __future__ import annotations

import io
import json
import logging
import zipfile
from collections import OrderedDict
from collections.abc import Iterator, Mapping
from dataclasses import dataclass
from datetime import UTC, datetime

from data_rover.core.metamodel.schema import Metamodel
from data_rover.core.model.model import Model
from data_rover.core.script.embed import ScriptEvalContext
from data_rover.core.script.runner import (
    RunLimits,
    ScriptBudget,
    ScriptError,
    ScriptRunner,
    SnippetSession,
)
from data_rover.core.table.cells import Cell
from data_rover.core.table.evaluate import (
    SortSpec,
    TableLimits,
    build_rows_ex,
    iter_export_rows,
    order_rows,
)
from data_rover.core.table.csv_export import render_csv
from data_rover.core.table.export_layout import (
    export_definition,
    export_header,
    export_layout,
)
from data_rover.core.table.exporter import (
    ExportFormat,
    JSON_FAMILY,
    JsonDocumentOptions,
)
from data_rover.core.table.json_export import (
    contains_error_marker,
    jsonl_bytes,
    render_json_ex,
)
from data_rover.core.table.naming import SPLIT_TOKENS, validate_tokens
from data_rover.core.table.resolve import table_has_script
from data_rover.core.table.schema import TableDefinition
from data_rover.core.table.split import (
    partition_label,
    render_filenames,
    split_partitions,
    validate_template,
)

from .deps import Session
from .schemas import ScriptStatusOut
from .script_eval import close_script_context, open_script_context
from .script_runner import run_limits_from_settings
from .script_sweep import SweepJob, kick_or_join_sweep
from .settings import Settings
from .snippet_concurrency import concurrency_guard
from .table_export import build_workbook

logger = logging.getLogger(__name__)

#: LRU cap on `TransformHost._sessions`. An exporter entry's transform can be
#: inline code, so distinct code per entry (not one snippet shared across
#: MAX_EXPORTER_ENTRIES entries) is the case to size for, against a
#: `snippet_pool_size` of warm guests and the per-store memory cap.
_TRANSFORM_SESSION_CACHE_MAX = 8


@dataclass(frozen=True)
class ExportPending:
    status: ScriptStatusOut


@dataclass(frozen=True)
class ExportFiles:
    files: list[tuple[str, bytes]]  # (filename WITH extension, blob)
    truncated: bool
    degraded: bool
    archive: bool  # True => ship as zip even if len==1


class TransformUnavailableError(Exception):
    """A transform-bearing export cannot run AT ALL: no runner constructed,
    or no interactive concurrency slot free. The ONE exception to this
    engine's degraded-not-failed stance: silently skipping a
    transform ships untransformed data — a functional-contract breach, not a
    cosmetic degradation — and 422 would mislabel a transient condition as a
    definition error. Routes map busy=False -> 503, busy=True -> 429,
    matching the snippet-console precedent."""

    def __init__(self, message: str, *, busy: bool) -> None:
        super().__init__(message)
        self.busy = busy


@dataclass(frozen=True)
class TransformOutcome:
    """One `transform(doc)` call, structured: `value` is the replacement
    document (meaningful only when `error` is None), `stdout` what the call
    printed, `error` the snippet's own failure (boot, raise, timeout,
    unserializable return). Host-side size caps are NOT an `error` — those
    raise ValueError from `apply_ex` too, since they are the run's limits,
    not something the snippet author can see in a traceback."""

    value: object
    stdout: str
    error: ScriptError | None
    duration_ms: int
    #: True when `error` is the session's boot error (the module itself
    #: failed to exec) rather than the `transform(doc)` call's.
    boot: bool = False


class TransformHost:
    """One export run's transform executor: up to `_TRANSFORM_SESSION_CACHE_MAX`
    warm SnippetSessions, one per DISTINCT transform code and shared across
    every entry/file that uses the same snippet, LRU-evicted past that cap;
    one global interactive slot for the whole run, one ScriptBudget shared by
    every call. Construct through `open_transform_host`; always `close()` in
    a finally."""

    def __init__(
        self,
        runner: ScriptRunner,
        model: Model,
        limits: RunLimits,
        budget: ScriptBudget,
        max_bytes: int,
    ) -> None:
        self._runner = runner
        self._model = model
        self._limits = limits
        self._budget = budget
        self._max_bytes = max_bytes
        # Insertion order = recency order: a hit moves its code to the end
        # (most-recently-used), so the front is always the eviction target.
        self._sessions: OrderedDict[str, SnippetSession] = OrderedDict()
        self._released = False

    def apply(self, code: str, doc: object, name: str) -> object:
        """Run `transform(doc)` and return the replacement document.

        Failure = failure: a boot error, a raise, a timeout, an
        unserializable return, or a size breach raises ValueError naming
        `name` — the routes' existing ValueError -> 422 mapping carries it,
        so a machine consumer never receives a half-transformed 200."""
        out = self.apply_ex(code, doc, name)
        if out.error is not None:
            if out.boot:
                raise ValueError(
                    f"{name}: transform failed to load: {out.error.message}"
                )
            raise ValueError(
                f"{name}: transform failed ({out.error.kind}): {out.error.message}"
            )
        return out.value

    def apply_ex(self, code: str, doc: object, name: str) -> TransformOutcome:
        """`apply` with the snippet's failure returned, not raised — for the
        transform preview, which renders a traceback the way the snippet
        console does. The size caps still raise (see `TransformOutcome`)."""
        blob = json.dumps(doc, ensure_ascii=False, separators=(",", ":"))
        if len(blob.encode("utf-8")) > self._max_bytes:
            raise ValueError(
                f"{name}: transform document exceeds "
                f"snippet_transform_max_bytes ({self._max_bytes})"
            )
        session = self._sessions.get(code)
        if session is not None:
            self._sessions.move_to_end(code)
        else:
            if len(self._sessions) >= _TRANSFORM_SESSION_CACHE_MAX:
                _, evicted = self._sessions.popitem(last=False)
                try:
                    evicted.close()
                except Exception:
                    # Eviction is warm-start upkeep for a DIFFERENT entry, not
                    # the result `apply()` is currently producing for `name` —
                    # a failing close() here must not surface as THIS entry's
                    # ValueError. Best-effort teardown; the interpreter is
                    # discarded from the cache either way.
                    logger.warning(
                        "transform session eviction: close() raised", exc_info=True
                    )
            session = self._runner.open_session(
                self._model, code, self._limits, budget=self._budget
            )
            self._sessions[code] = session
        if session.boot_error is not None:
            return TransformOutcome(
                value=None, stdout="", error=session.boot_error, duration_ms=0, boot=True
            )
        res = session.call("transform", [], doc=doc)
        if res.error is not None:
            return TransformOutcome(
                value=None, stdout=res.stdout, error=res.error, duration_ms=res.duration_ms
            )
        assert res.value is not None  # decode contract: value xor error
        out = res.value["value"]
        out_blob = json.dumps(out, ensure_ascii=False, separators=(",", ":"))
        if len(out_blob.encode("utf-8")) > self._max_bytes:
            raise ValueError(
                f"{name}: transform result exceeds "
                f"snippet_transform_max_bytes ({self._max_bytes})"
            )
        return TransformOutcome(
            value=out, stdout=res.stdout, error=None, duration_ms=res.duration_ms
        )

    def close(self) -> None:
        if self._released:
            return
        self._released = True
        # try/finally: a raising session.close() must not leak the global
        # interactive slot forever (`_released` is already set above, so a
        # retry after a raise here would silently no-op and never release).
        try:
            for s in self._sessions.values():
                s.close()
            self._sessions.clear()
        finally:
            concurrency_guard.release_global()


def open_transform_host(
    runner: ScriptRunner | None, model: Model, settings: Settings
) -> TransformHost:
    """Acquire ONE interactive slot and build the run's TransformHost.
    Raises TransformUnavailableError (busy=False no runner / busy=True no
    slot) — see that class's docstring for why this is not a degradation."""
    if runner is None:
        raise TransformUnavailableError("script runner unavailable", busy=False)
    if not concurrency_guard.try_acquire_global(
        global_limit=settings.snippet_concurrency
    ):
        raise TransformUnavailableError("snippet runner busy", busy=True)
    return TransformHost(
        runner,
        model,
        run_limits_from_settings(settings),
        ScriptBudget.start(settings.snippet_eval_budget_s),
        settings.snippet_transform_max_bytes,
    )


def json_key_column(
    format: ExportFormat,
    json_doc: JsonDocumentOptions | None,
    defn: TableDefinition,
    name: str,
) -> int | None:
    """The object-shape key column, validated: json only (jsonl ignores shape
    with tolerance). Checked BEFORE rendering — the range half is knowable
    now, and `render_json_ex` re-checks it anyway. ValueError -> 422."""
    if format != "json" or json_doc is None or json_doc.shape != "object":
        return None
    if json_doc.key_column is None:
        raise ValueError(f"{name}: json_doc.shape 'object' requires key_column")
    if not 0 <= json_doc.key_column < len(defn.columns):
        raise ValueError(
            f"{name}: json_doc.key_column {json_doc.key_column} out "
            f"of range (table has {len(defn.columns)} columns)"
        )
    return json_doc.key_column


def shape_json_docs(
    format: ExportFormat,
    docs: list[dict[str, object]],
    doc_keys: list[str] | None,
) -> object:
    """The document `transform(doc)` receives and the serializer writes:
    jsonl is always the row list; json is the keyed object when the render
    produced keys (object shape), the row list otherwise."""
    if format == "jsonl":
        return docs
    return dict(zip(doc_keys, docs, strict=True)) if doc_keys is not None else docs


@dataclass(frozen=True)
class JsonSample:
    """A bounded render of one JSON-family export: `doc` is exactly what the
    export would hand to `transform(doc)` (or serialize) for the sampled
    rows. `split_file` names the previewed partition's file when the entry
    splits — a split export transforms once PER FILE, so the sample is the
    first partition's document, never the unsplit whole."""

    doc: object
    truncated: bool
    split_file: str | None


def render_json_sample(
    *,
    metamodel: Metamodel,
    model: Model,
    defn: TableDefinition,
    render_defn: TableDefinition,
    format: ExportFormat,
    json_doc: JsonDocumentOptions | None,
    name: str,
    template_vars: Mapping[str, str],
    script_ctx: ScriptEvalContext | None,
    max_rows: int,
) -> JsonSample:
    """The transform preview's input: the first `max_rows` rows of `defn`,
    rendered and shaped exactly like `run_table_export`'s JSON branch (same
    layout, `export_definition`, key column, split partitioning) but bounded
    and never 202 — `script_ctx` is expected to be cache-only, so an
    uncomputed script cell renders its `$error` marker, as
    `/tables/json-preview` does. `json_doc.on_error` is deliberately not
    applied: the preview is about the transform, and a cache-only render
    would trip `fail` on cells the real export waits for."""
    if format not in JSON_FAMILY:
        raise ValueError(
            f"{name}: transform is only supported for JSON-family formats, "
            f"not {format!r}"
        )
    limits = TableLimits(max_cell_elements=10**9, ignore_cell_caps=True)
    build = build_rows_ex(metamodel, model, defn, limits, script=script_ctx)
    ordered = order_rows(metamodel, model, defn, build.keys, None, limits, script=script_ctx)
    window = ordered[:max_rows]
    truncated = len(ordered) > len(window)
    layout = export_layout(render_defn)
    eff = export_definition(render_defn)
    rn = (
        (layout.row_number_pos, layout.row_number_key)
        if layout.row_number_pos is not None
        else None
    )
    key_col = json_key_column(format, json_doc, defn, name)
    rows = iter_export_rows(metamodel, model, defn, window, limits, script=script_ctx)
    split = render_defn.json_split
    split_file: str | None = None
    if split is not None and split.enabled:
        validate_template(split.filename_template)
        validate_tokens(split.filename_template, SPLIT_TOKENS)
        parts = split_partitions(window, rows)
        if parts:
            binding, pairs = parts[0]
            stem = render_filenames(
                split.filename_template,
                [partition_label(model, binding)],
                extra=template_vars,
            )[0]
            split_file = f"{stem}.{format}"
            window = [rk for rk, _ in pairs]
            rows = iter(cells for _, cells in pairs)
            truncated = truncated or len(parts) > 1
        else:
            rows = iter([])
    docs, doc_keys = render_json_ex(
        model,
        eff,
        window,
        rows,
        build.base_slots,
        order=layout.rank,
        row_number=rn,
        key_column=key_col,
    )
    return JsonSample(
        doc=shape_json_docs(format, docs, doc_keys),
        truncated=truncated,
        split_file=split_file,
    )


def _drain(rows: Iterator[list[Cell]]) -> None:
    """Consume a lazy row stream for its SIDE EFFECTS only (the script calls
    each cell makes), discarding the cells chunk-by-chunk. Used by the export's
    completeness probe, where materializing the list would defeat the very
    bounded-peak-memory property `iter_export_rows` exists to provide."""
    for _ in rows:
        pass


def status_from_job(job: SweepJob) -> ScriptStatusOut:
    """Map a `SweepJob` onto the wire status of the request that kicked/joined it.

    CALLERS ONLY REACH THIS AFTER PENDING WAS SEEN (in the cache-only
    whole-table pass, in the visible-window pass, or both) — that is the
    function's whole precondition, and it is why no branch here can return
    `ready`. This response was already assembled before those values existed
    (possibly degraded to build order, possibly carrying `pending` cells), so
    even a sync/racing sweep that FINISHED during this very request must report
    `computing`: the client polls once more and gets the clean page from the
    now-full cache.

    Both DEAD job states collapse onto `failed`. `cancelled` is not a
    pathology (a rev change or an eviction cancelled it, never the snippet),
    but no thread is behind it any more, so reporting `computing` would strand
    the poller forever — `failed` is the honest terminal answer, and the cause
    of a cancel is always something (a commit) that re-keys the sweep registry
    and gets a fresh job kicked on the next request anyway.
    """
    if job.state in ("failed", "cancelled"):
        return ScriptStatusOut(
            state="failed", done=job.done, total=job.total, message=job.message
        )
    return ScriptStatusOut(state="computing", done=job.done, total=job.total)


#: Fixed member timestamp: identical content zips byte-identically (the
#: determinism stance the WASM runner takes for snippet output).
ZIP_DATE_TIME = (1980, 1, 1, 0, 0, 0)


#: Content type per shipped file extension. One map for the standalone
#: route's single-file response, `/exports/run`'s bare mode, and anything
#: else that needs to name a format's media type — extending a format means
#: extending THIS, once.
MEDIA_TYPES: dict[str, str] = {
    "xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    "json": "application/json",
    "csv": "text/csv; charset=utf-8",
    "jsonl": "application/x-ndjson",
}


def build_zip(files: list[tuple[str, bytes]]) -> bytes:
    """Zip `files` (name, blob) pairs with every member timestamp pinned to
    `ZIP_DATE_TIME`. `zipfile` otherwise stamps each entry with the current
    wall-clock time, which would make two exports of IDENTICAL content
    produce DIFFERENT bytes — the same determinism stance the WASM snippet
    runner takes for its own output (see `core/script/README.md`). Pinning
    the timestamp is what makes a byte-equality test on the zip exact rather
    than merely "same entries"."""
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
        for filename, blob in files:
            info = zipfile.ZipInfo(filename, date_time=ZIP_DATE_TIME)
            info.compress_type = zipfile.ZIP_DEFLATED
            zf.writestr(info, blob)
    return buf.getvalue()


def export_context_vars(session: Session, project_id: str) -> dict[str, str]:
    """The RUN-LEVEL `${...}` template context (`naming.CONTEXT_TOKENS`):
    `${rev}`/`${date}`/`${project}`. Defined ONCE here so `routes/exports.py`
    and `routes/tables.py`'s standalone `/tables/export` share identical
    values for the same request rather than each deriving its own — `date`
    in particular must not drift between an exporter's several entries
    rendered within one call. `project` is the project ID (machine-oriented
    naming input), never the display name."""
    return {
        "rev": str(session.model_rev),
        "date": datetime.now(UTC).strftime("%Y%m%d"),
        "project": project_id,
    }


def run_table_export(
    *,
    session: Session,
    settings: Settings,
    runner: ScriptRunner | None,
    metamodel: Metamodel,
    model: Model,
    defn: TableDefinition,  # evaluation — the ORIGINAL definition
    render_defn: TableDefinition,  # presentation — same object for /tables/export
    name: str,
    format: ExportFormat,
    sort: SortSpec | None,
    template_vars: Mapping[str, str] | None = None,
    json_doc: JsonDocumentOptions | None = None,
    transform_code: str | None = None,  # resolved snippet code (never a ref)
    transform_host: TransformHost | None = None,  # run-owned; NOT closed here
) -> ExportPending | ExportFiles:
    """Exports the WHOLE table (every row `build_rows`/`order_rows` produce,
    honoring `max_rows` and the requested sort) — unlike `/tables/evaluate`,
    there is no `offset`/`limit` windowing here. `format` picks the shape:
    `"xlsx"` ships a single-sheet
    `application/vnd.openxmlformats-officedocument.spreadsheetml.sheet`
    workbook via `build_workbook`; `"json"` ships `application/json` via
    `render_json_ex`, one object per (possibly grouped) row — see
    `core/table/json_export.py` for the grouping rules; `"csv"` ships
    `text/csv` via `render_csv`, sharing xlsx's cell display text through
    `core/table/cell_text.py` so the two formats cannot drift; `"jsonl"`
    ships `application/x-ndjson` via `jsonl_bytes`, one compact object per
    line — the JSON-family renderer (`render_json_ex`) underneath both
    `"json"` and `"jsonl"`.

    `json_doc` is entry-level document shaping — object vs. array
    shape (with a `key_column`), compact vs. pretty printing, and whether an
    in-band `{"$error": ...}` marker anywhere in the export turns into a
    422 instead of shipping. It is consulted ONLY inside the json/jsonl
    branch: `None` for the standalone route and for xlsx/csv, and `shape`/
    `pretty` are ignored with tolerance on `jsonl` (only `on_error` applies
    there) — see `JsonDocumentOptions`'s own docstring.

    `transform_code`/`transform_host` are the export-transform
    hook: a `transform(doc)` snippet run once the document is otherwise
    ready to ship. Supported on BOTH surfaces (the standalone
    `/tables/export` route and each `/exports/run` entry), JSON-family
    formats only (`format not in JSON_FAMILY` with `transform_code` set is a
    422 — see the guard right below). It sits at the END of the pipeline —
    shape, THEN transform, THEN serialize — so it sees exactly the
    array/object/row-list a consumer would otherwise receive, never the raw
    row cells. On the split path it runs ONCE PER FILE (one call per
    partition, not once for the whole export), after `_check_on_error` has
    already scanned that file's rendered docs (a transform must
    not be able to launder an error marker past that check by transforming
    it away). `transform_host` is caller-owned — this function calls
    `.apply()` but never `.close()`s it, since one host is shared across
    however many `run_table_export` calls one export request makes (every
    entry of an `/exports/run` batch, or the split files of one standalone
    export).

    Cells are evaluated with `max_cell_elements` overridden to effectively
    unbounded (10**9): the interactive page route caps a navigation cell's
    element list at `cell_cap` purely for on-screen display, but an export
    must contain the COMPLETE reached set for every navigation cell — capping
    it here would silently drop data the user asked to export. Row count is
    still governed by `TableLimits.max_rows`; `truncated` is set when
    `build_rows` reports an incomplete row set (its own `max_rows` cap, or an
    underlying navigation that hit its `max_chains`/`max_visited` budget),
    never for cell-level capping (which cannot happen with this override).

    Script columns: an export is the one route that MUST touch every
    row, so running it inline would be exactly the O(rows) guest grind
    background sweeping exists to remove. Instead the whole thing runs CACHE-ONLY and this function
    probes for completeness first; if anything is still uncomputed it kicks/joins
    the background sweep and answers `ExportPending` (the callers translate that
    to 202 + `Retry-After: 1`) rather than shipping a half-computed file. The
    202-vs-ship decision is made by RE-PROBING the cache after the kick/join
    (decision table below, in this function's body): a finished sweep does not
    imply a complete cache, so "would a retry help" — not "is the job over" —
    is the discriminator. When it would not (a terminal sweep that still left holes,
    or no runner at all) the file still ships with pending cells surfaced —
    but the four formats carry that differently. The `.xlsx` branch renders
    each affected cell `#ERROR` and appends a trailing notice row; the `.json`
    branch has no sheet and no notice row to append, so it marks each affected
    cell in-band with a `{"$error": ...}` object instead (see `render_cell` in
    `core/table/json_export.py`). `.csv` reuses the SAME `#ERROR:` cell text as
    xlsx (both go through `core/table/cell_text.py`) but ships no trailing
    notice row either — to a CSV parser a notice would be one more data row —
    so a CSV consumer's only degradation signals are the in-band `#ERROR:`
    text and the `X-Table-Script-Errors` response header. `.jsonl` inherits
    json's in-band `{"$error": ...}` markers, one per line, since both formats
    render through the same `render_json_ex`. Every branch still sets
    `degraded=True` on the returned `ExportFiles` when this happens, so a
    caller can detect degradation without parsing the body."""
    split = render_defn.json_split
    split_on = format in JSON_FAMILY and split is not None and split.enabled
    if split_on:
        assert split is not None  # split_on implies this; narrows for mypy
        # Strict by decision: the ONE export setting that rejects
        # rather than normalizes. Before any evaluation — a bad template must
        # not cost a whole-table pass. ValueError -> the routes' 422 mapping.
        # Token strictness lives here, not only in /exports/run's per-entry
        # pass, so the standalone /tables/export route rejects a typo'd
        # `${revv}` too instead of shipping it verbatim in filenames.
        validate_template(split.filename_template)
        validate_tokens(split.filename_template, SPLIT_TOKENS)
    if transform_code is not None and format not in JSON_FAMILY:
        # A functional contract, not presentation: silently
        # skipping ships untransformed data, so no tolerate-and-ignore.
        raise ValueError(
            f"{name}: transform is only supported for JSON-family formats, "
            f"not {format!r}"
        )
    script_ctx = None
    acquired = False
    try:
        # Export never caps cells: lift the server-wide ceiling AND drop each
        # navigation column's per-column `cell_cap` display preference.
        limits = TableLimits(max_cell_elements=10**9, ignore_cell_caps=True)
        rev = session.model_rev
        script_ctx, acquired = open_script_context(
            runner,
            model,
            settings,
            needs_script=table_has_script(defn),
            cell_cache=session.script_cell_cache,
            rev=rev,
        )
        # Every whole-table pass below (build, order, the completeness probe AND
        # the export render itself) runs CACHE-ONLY: an export must never drive
        # the guest O(rows) times inline. The flag is set once here
        # and deliberately never cleared.
        if script_ctx is not None:
            script_ctx.cache_only = True
        build = build_rows_ex(metamodel, model, defn, limits, script=script_ctx)
        keys, truncated = build.keys, build.truncated
        ordered = order_rows(
            metamodel, model, defn, keys, sort, limits, script=script_ctx
        )
        if script_ctx is not None:
            # COMPLETENESS PROBE — do not "optimize" this pass away.
            #
            # `build_rows`/`order_rows` only invoke a script column's `value()`
            # when that column FILTERS (`keep_empty=False`), is the SORT column,
            # or is an EXPAND column. A plain collapse `keep_empty=True` DISPLAY
            # column is invisible to both, so judging completeness from those two
            # passes alone reports `pending_misses == 0` on a stone-cold cache —
            # and the export 200s with a silent `#ERROR` in every row of that
            # column. Rendering every row here is what makes the check honest.
            #
            # It is cheap: cache-only means dict lookups and no guest work, and
            # the per-request memo makes the later `iter_export_rows` render
            # nearly free. The rows are streamed and DISCARDED chunk-by-chunk
            # (`for _ in ...: pass`) exactly like the real render, so the probe
            # never materializes 50 000 rows x every column just to throw them
            # away — it makes the same calls at a bounded peak memory.
            _drain(
                iter_export_rows(
                    metamodel, model, defn, ordered, limits, script=script_ctx
                )
            )
            if script_ctx.pending_misses > 0 and runner is not None:
                # Lock stance: this route holds NO session lock (no write_mutex —
                # same benign-race stance as /tables/evaluate), so kicking is
                # safe even in the sync sweep mode where `kick_or_join_sweep`
                # runs the whole sweep on this thread. We never BLOCK on a job.
                job = kick_or_join_sweep(
                    session, metamodel, model, defn, runner, settings, rev
                )
                status = status_from_job(job)
                # Terminality is read off the WIRE state, which collapses both
                # DEAD job states (`failed` and `cancelled`) onto `failed` (no
                # thread is behind either), PLUS the `done` job state — which
                # `status_from_job` deliberately reports as `computing` and so
                # cannot be recovered from `status` alone.
                terminal = status.state == "failed" or job.state == "done"
                #
                # The honest question, once a job exists, is not "did the job
                # finish" but "would a RETRY ACTUALLY HELP", i.e. is the cache
                # complete NOW — and a RE-PROBE (below) is how that gets
                # answered. But the re-probe is only ever CONSULTED for a
                # terminal job:
                #
                #   job state       | re-probe? | answer
                #   ----------------+-----------+------------------------------
                #   running         | SKIPPED   | 202 unconditionally (FIX A) —
                #                   |           | work is genuinely in flight,
                #                   |           | and nothing a re-probe could
                #                   |           | find changes that answer, so
                #                   |           | running it would just be an
                #                   |           | O(rows) navigation-column
                #                   |           | re-walk paid for nothing:
                #                   |           | non-script columns are NOT
                #                   |           | memoized, so this cost would
                #                   |           | repeat every second of a poll
                #                   |           | loop that already knows its
                #                   |           | answer.
                #   terminal, none  | consulted | 202 — the cache IS complete
                #   re-probe misses |           | but THIS request's `ordered`
                #                   |           | predates it (sync sweeps fill
                #                   |           | the cache after the build), so
                #                   |           | retry for correct order and
                #                   |           | real values. The wire `state`
                #                   |           | in the body is forced to
                #                   |           | `computing` here (FIX B) even
                #                   |           | when `job.state` is a DEAD
                #                   |           | `failed`/`cancelled` — the
                #                   |           | retry WILL succeed (the values
                #                   |           | are already in the cache), so
                #                   |           | reporting the job's own dead
                #                   |           | state would tell the client to
                #                   |           | abandon a download the very
                #                   |           | next poll would deliver.
                #   terminal, some  | consulted | fall through — nothing will
                #   re-probe misses |           | ever fill those cells at this
                #                   |           | rev (`ScriptCellCache.put`
                #                   |           | refuses non-deterministic
                #                   |           | error kinds while the sweep
                #                   |           | only aborts on a CONSECUTIVE
                #                   |           | run of them, so one
                #                   |           | intermittently-timing-out cell
                #                   |           | leaves a permanent hole in an
                #                   |           | otherwise `done` sweep), so
                #                   |           | ship the honest terminal
                #                   |           | export (`#ERROR`). Answering
                #                   |           | 202 off `state != "failed"`
                #                   |           | alone would loop forever here
                #                   |           | (same rev => failed-job memory
                #                   |           | hands back the same `done` job
                #                   |           | => `computing` => 202 => ...).
                if not terminal:
                    return ExportPending(status=status)
                # RE-PROBE (terminal jobs only — see table above). The
                # re-reading is TRUTHFUL despite reusing this context: a
                # `pending` result is never memoized and never written to the
                # cell cache (see `ScriptEvalContext.call`), so every cell that
                # missed the first time re-consults the (now sweep-filled) cell
                # cache instead of being served a stale pending from the memo.
                # Only genuine HITS are memoized, and those were not misses in
                # the first probe either. A fresh miss counter baseline is all
                # that is needed to keep the first probe's misses out of it.
                miss_baseline = script_ctx.pending_misses
                _drain(
                    iter_export_rows(
                        metamodel, model, defn, ordered, limits, script=script_ctx
                    )
                )
                still_pending = script_ctx.pending_misses > miss_baseline
                if not still_pending:
                    # FIX B: the wire body must not say `state: "failed"` here.
                    # This 202 means "the cache filled in behind this request —
                    # retry and you'll get real data", which is true REGARDLESS
                    # of what killed the job (a `done` sweep already reports
                    # `computing` via `status_from_job`; a `failed`/`cancelled`
                    # one does not, and that mismatch is exactly the bug: the
                    # job is dead, but the DATA it needed is not, because those
                    # cells were satisfied some other way — pre-warmed, or
                    # computed before the abort landed). `ScriptStatusOut`'s own
                    # docstring defines `failed` as work that "will not finish
                    # on its own"; that is false here, so the body must not
                    # claim it. Status code, `Retry-After`, and `done`/`total`
                    # are untouched — only the wire `state` is overridden.
                    return ExportPending(
                        status=status.model_copy(update={"state": "computing"})
                    )
            # Fall through on a terminal-but-incomplete sweep (or no runner at
            # all) and export with pending rendered as `#ERROR` — the honest
            # terminal answer.

        # Export settings are PRESENTATION: the layout says what the file
        # contains and in what order. It is for the RENDER only —
        # `iter_export_rows` below keeps the ORIGINAL `defn`, so cell values,
        # row order, and every script cache key are exactly what they would be
        # without any of this. (`export_definition`, the other half of that
        # boundary, is built inside the JSON branch and nowhere else — see
        # there.)
        layout = export_layout(render_defn)
        headers = [export_header(render_defn, i) for i in layout.order]
        if layout.row_number_pos is not None:
            headers.insert(layout.row_number_pos, layout.row_number_header)
        all_rows = iter_export_rows(
            metamodel, model, defn, ordered, limits, script=script_ctx
        )
        # Baseline for the RENDER's own pending misses (see `_degraded` below).
        # Sampled here, after every probe pass, so only cells that the workbook
        # actually rendered as `#ERROR: not computed` are counted.
        render_miss_baseline = script_ctx.pending_misses if script_ctx else 0

        def _degraded() -> bool:
            """Did this workbook ship any `#ERROR` cell?

            `errored` alone is NOT the answer. A cache-only `pending` result is
            a deliberate non-error (it must not poison the row-order cache, so
            `ScriptEvalContext.call` leaves `errored` False by design) — but
            `table_export.py` still renders it `#ERROR: not computed`. On the
            terminal fall-through above, and on the runner-unavailable path
            (whose context is cache-only too, so its cells come back `pending`
            rather than `unavailable`), EVERY affected cell is `#ERROR` while
            `errored` stays False. Signalling nothing there hands the user a
            workbook that looks authoritative and is entirely `#ERROR`, and a
            programmatic client a clean 200. So OR in the misses the render
            itself recorded. `errored`'s meaning is left untouched."""
            if script_ctx is None:
                return False
            return (
                script_ctx.errored or script_ctx.pending_misses > render_miss_baseline
            )

        def _notice() -> str | None:
            # `row_iter` (and therefore any script column's `value()` calls)
            # is consumed lazily INSIDE `build_workbook` — the flags `_degraded`
            # reads are only fully settled once that consumption finishes, so
            # this must be a callable invoked AFTER the row loop, not a value
            # computed up front.
            if _degraded():
                return (
                    "Some script cells failed, could not be computed, or "
                    "exceeded the evaluation budget; affected cells are "
                    "marked #ERROR."
                )
            return None

        if format in JSON_FAMILY:
            # `export_definition` restates inclusion as `hidden` so
            # `json_export`'s existing hidden-column and group-nesting logic is
            # reused rather than reimplemented. Built HERE rather than beside
            # `layout` above because only this branch renders through it: the
            # xlsx path slices rows by `layout.order` and never sees an
            # export-effective definition at all, which is the render-only
            # boundary made visible instead of merely argued.
            eff = export_definition(render_defn)
            rn = (
                (layout.row_number_pos, layout.row_number_key)
                if layout.row_number_pos is not None
                else None
            )
            key_col = json_key_column(format, json_doc, defn, name)

            def _check_on_error(docs: list[dict[str, object]]) -> None:
                # Under "fail" a machine consumer gets a clean
                # document or nothing — scanned per FILE, after render,
                # before serialization. ValueError -> the routes' 422.
                if (
                    json_doc is not None
                    and json_doc.on_error == "fail"
                    and any(contains_error_marker(d) for d in docs)
                ):
                    raise ValueError(
                        f"{name}: export contains error cells and "
                        "json_doc.on_error is 'fail'"
                    )

            def _shape(
                docs: list[dict[str, object]], doc_keys: list[str] | None
            ) -> object:
                return shape_json_docs(format, docs, doc_keys)

            def _transformed(payload: object) -> object:
                if transform_code is None:
                    return payload
                assert transform_host is not None  # routes pair them
                out = transform_host.apply(transform_code, payload, name)
                if format == "jsonl" and not isinstance(out, list):
                    # jsonl is newline-delimited; a non-list return
                    # has no honest line serialization.
                    raise ValueError(
                        f"{name}: transform must return a list for jsonl; "
                        f"got {type(out).__name__}"
                    )
                return out

            def _to_bytes(payload: object) -> bytes:
                if format == "jsonl":
                    assert isinstance(payload, list)  # _transformed enforced it
                    return jsonl_bytes(payload)
                if json_doc is not None and not json_doc.pretty:
                    return json.dumps(
                        payload, ensure_ascii=False, separators=(",", ":")
                    ).encode("utf-8")
                return json.dumps(payload, ensure_ascii=False, indent=2).encode("utf-8")

            if split_on:
                assert split is not None  # split_on implies this
                # Split sits ABOVE the renderer, not inside it: each partition
                # goes through the SAME `render_json_ex` call with the SAME
                # layout arguments as the unsplit path, so a split file is
                # exactly the rows its partition contributes, rendered and
                # shaped identically to how the unsplit export renders them
                # (see the module docstring on `core/table/split.py`). This is
                # NOT "concatenating every split file reproduces the unsplit
                # export byte-for-byte" — that claim is false under
                # `shape: "object"` (concatenating keyed objects does not
                # reconstruct one array or one object), and even under the
                # array shape each partition is a strict subset of the whole,
                # not the whole itself.
                parts = split_partitions(ordered, all_rows)
                labels = [partition_label(model, b) for b, _ in parts]
                stems = render_filenames(
                    split.filename_template, labels, extra=template_vars
                )
                files = []
                for stem, (_, pairs) in zip(stems, parts, strict=True):
                    part_docs, part_keys = render_json_ex(
                        model,
                        eff,
                        [rk for rk, _ in pairs],
                        (cells for _, cells in pairs),
                        build.base_slots,
                        order=layout.rank,
                        row_number=rn,
                        key_column=key_col,
                    )
                    _check_on_error(part_docs)
                    files.append(
                        (
                            f"{stem}.{format}",
                            _to_bytes(_transformed(_shape(part_docs, part_keys))),
                        )
                    )
                return ExportFiles(
                    files=files,
                    truncated=truncated,
                    degraded=_degraded(),
                    archive=True,
                )
            # `render_json_ex` indexes cells by DEFINITION column index, so it
            # gets the UNFILTERED rows — excluded columns are dropped inside it
            # by their `None` key, not by pre-slicing the row like the xlsx
            # path does.
            docs, doc_keys = render_json_ex(
                model,
                eff,
                ordered,
                all_rows,
                build.base_slots,
                order=layout.rank,
                row_number=rn,
                key_column=key_col,
            )
            _check_on_error(docs)
            blob = _to_bytes(_transformed(_shape(docs, doc_keys)))
            filename = f"{name}.{format}"
            # No JSON analogue of the xlsx trailing notice row: the `$error`
            # markers are in-band and the header below carries the summary.
        elif format == "csv":
            # Same layout slicing as the xlsx branch (headers already carry
            # the row-number header at its position); cell text shared via
            # core/table/cell_text so the two formats cannot drift.
            # No split, no json_doc — both tolerantly ignored, like
            # json_split already is on xlsx.
            blob = render_csv(
                model,
                headers,
                ([row[i] for i in layout.order] for row in all_rows),
                row_number_col=layout.row_number_pos,
            )
            filename = f"{name}.csv"
        else:
            blob = build_workbook(
                model,
                headers,
                name,
                ([row[i] for i in layout.order] for row in all_rows),
                notice_provider=_notice,
                row_number_col=layout.row_number_pos,
            )
            filename = f"{name}.xlsx"
        return ExportFiles(
            files=[(filename, blob)],
            truncated=truncated,
            degraded=_degraded(),
            archive=False,
        )
    finally:
        close_script_context(script_ctx, acquired)
