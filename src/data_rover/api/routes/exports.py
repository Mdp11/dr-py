"""Run an exporter artifact: every entry's table export, one zip.

Read-only (viewer-callable): running an export commits nothing — only edits
to the artifact's DEFINITION go through POST /commits.
Spec: docs/superpowers/specs/2026-08-13-table-export-split-and-custom-export-design.md §4.3
Spec: docs/superpowers/specs/2026-08-19-custom-export-v2-design.md
"""

from __future__ import annotations

from typing import Literal

from fastapi import APIRouter, Depends, HTTPException, Response
from fastapi.responses import JSONResponse
from sqlalchemy.orm import Session as DbSession

from data_rover.core.navigation.resolve import NavigationResolveError
from data_rover.core.script.runner import ScriptRunner
from data_rover.core.table.exporter import (
    EXPORTER_ADAPTER,
    ExporterDefinition,
    JSON_FAMILY,
    overridden_table,
)
from data_rover.core.table.naming import (
    NAME_TOKENS,
    SPLIT_TOKENS,
    folder_segments,
    substitute,
    validate_tokens,
)
from data_rover.core.table.split import sanitize_stem, validate_template

from .. import content
from ..db import get_db
from ..db_models import ArtifactKind, ArtifactRow
from ..deps import Session, get_request_session, require_model
from ..export_manifest import MANIFEST_NAME, ManifestEntry, build_manifest
from ..schemas import EvaluateTableIn, RunExportIn, ScriptStatusOut
from ..script_runner import get_runner
from ..settings import Settings, get_settings
from ..table_export_engine import (
    MEDIA_TYPES,
    ExportFiles,
    ExportPending,
    TransformUnavailableError,
    build_zip,
    export_context_vars,
    open_transform_host,
    run_table_export,
)
from .tables import _resolve_table, _resolve_transform_code

router = APIRouter()


def _dedupe_path(prefix: str, stem: str, taken: set[str]) -> str:
    """Dedupe `stem` against every OTHER entry landing in the same folder.

    `taken` holds FULL `prefix + stem` member paths (extension-less), so two
    entries that render to the same name in DIFFERENT folders never force a
    suffix on each other — only a collision within the same `prefix` does.
    Returns the (possibly suffixed) stem alone; the caller still prepends
    `prefix` to build the actual archive member path.

    A split entry's own produced member paths (`{prefix}{folder}/{stem}`,
    one per partition) also get reserved into `taken` — see the assembly
    loop below — using this same extension-less shape, so a plain entry
    that happens to render into a split entry's folder (e.g. split entry
    "X" writing `X/root.json`, a sibling entry named "root" landing in
    folder "X") collides here instead of silently overwriting a zip member.
    Before folders existed a non-split member could never contain `/` and
    so could never equal a split member's path; folders make that equality
    reachable, which is what makes this reservation load-bearing rather than
    defensive."""
    candidate, n = stem, 2
    while f"{prefix}{candidate}" in taken:
        candidate = f"{stem}_{n}"
        n += 1
    taken.add(f"{prefix}{candidate}")
    return candidate


def _aggregate_pending(statuses: list[ScriptStatusOut]) -> ScriptStatusOut:
    """Combine every still-pending entry's `ScriptStatusOut` into the ONE
    aggregate 202 the whole zip answers with.

    `computing` wins over `failed` even when another entry is dead: a
    retryable in-flight state must never be reported as terminal, because
    this is a single response covering MULTIPLE entries — if even one of
    them will still fill in on its own, the honest answer for the whole
    request is "poll again", not "give up" (same reasoning as the per-table
    FIX B in `table_export_engine.status_from_job`: a client told `failed`
    abandons the download the very next poll would have delivered). Only
    when EVERY entry is dead does the aggregate report `failed`.

    `done`/`total` are summed across entries so a client rendering one
    progress bar for the whole export sees genuine combined progress rather
    than only the last entry's numbers.
    """
    state: Literal["computing", "failed"] = (
        "computing" if any(s.state == "computing" for s in statuses) else "failed"
    )
    return ScriptStatusOut(
        state=state,
        done=sum(s.done for s in statuses),
        total=sum(s.total or 0 for s in statuses),
    )


@router.post("/exports/run")
def run_export(
    payload: RunExportIn,
    project_id: str,
    session: Session = Depends(get_request_session),
    db: DbSession = Depends(get_db),
    runner: ScriptRunner | None = Depends(get_runner),
    settings: Settings = Depends(get_settings),
) -> Response:
    # Spec §9.1: exactly one source for the definition. Checked here, not on
    # the model, so the 422 detail is one plain sentence rather than a
    # pydantic error tree — this is a contract line for CI scripts.
    if (payload.artifact_id is None) == (payload.definition is None):
        raise HTTPException(
            status_code=422,
            detail="exactly one of artifact_id and definition is required",
        )
    if payload.artifact_id is not None:
        row = content.get_artifact(db, payload.artifact_id)
        if (
            row is None
            or row.project_id != project_id
            or row.kind is not ArtifactKind.exporter
        ):
            raise HTTPException(
                status_code=404, detail=f"unknown exporter {payload.artifact_id}"
            )
        cdef: ExporterDefinition = EXPORTER_ADAPTER.validate_python(row.payload)
        run_name, artifact_id = row.name, row.id
    else:
        assert payload.definition is not None  # the XOR check above
        cdef = payload.definition
        # `name` stands in for the artifact name (spec §9.1): ${name} in the
        # zip filename template, the stem fallback, and the manifest's
        # `artifact_name` all read it. `artifact_id: None` is the manifest's
        # draft marker.
        run_name, artifact_id = payload.name or "export", None
    return _execute_export(
        cdef,
        run_name=run_name,
        artifact_id=artifact_id,
        project_id=project_id,
        session=session,
        db=db,
        runner=runner,
        settings=settings,
    )


@router.get("/exports/run-by-name")
def run_export_by_name(
    name: str,
    project_id: str,
    session: Session = Depends(get_request_session),
    db: DbSession = Depends(get_db),
    runner: ScriptRunner | None = Depends(get_runner),
    settings: Settings = Depends(get_settings),
) -> Response:
    """CI ergonomics (spec §9.2): run a committed exporter by NAME with one
    `curl`. A QUERY parameter, not a path segment — artifact names are
    free-form text. GET is read-only by `authz`'s method-based write
    detection, so membership auth (header or cookie) works unchanged and the
    route is viewer-callable like the POST. Response contract identical to
    `POST /exports/run` — both delegate to `_execute_export`, including the
    aggregate `202 + Retry-After: 1` while sweeps fill."""
    rows = content.find_artifacts_by_name(db, project_id, ArtifactKind.exporter, name)
    if not rows:
        raise HTTPException(status_code=404, detail=f"unknown exporter {name!r}")
    if len(rows) > 1:
        raise HTTPException(
            status_code=409,
            detail=f"ambiguous exporter name {name!r}; candidates: {', '.join(r.id for r in rows)}",
        )
    row = rows[0]
    cdef: ExporterDefinition = EXPORTER_ADAPTER.validate_python(row.payload)
    return _execute_export(
        cdef,
        run_name=row.name,
        artifact_id=row.id,
        project_id=project_id,
        session=session,
        db=db,
        runner=runner,
        settings=settings,
    )


def _execute_export(
    cdef: ExporterDefinition,
    *,
    run_name: str,
    artifact_id: str | None,
    project_id: str,
    session: Session,
    db: DbSession,
    runner: ScriptRunner | None,
    settings: Settings,
) -> Response:
    """The whole run pipeline behind BOTH entry points (`POST /exports/run`
    with an id or a draft definition, `GET /exports/run-by-name`), so the
    202/zip/bare/manifest contract cannot drift between them. `run_name` is
    the artifact's name for a committed run and the request's `name` for a
    draft (`artifact_id` None marks the draft in the manifest, spec §9.1);
    everything downstream is source-agnostic."""
    metamodel, model = require_model(session)
    if not cdef.entries:
        raise HTTPException(status_code=422, detail="exporter has no entries")

    # Run-level `${rev}`/`${date}`/`${project}` context, shared by every
    # entry's name/folder template and by the zip filename (Task 6) — ONE
    # `date` for the whole request, not one per entry.
    ctx = export_context_vars(session, project_id)
    try:
        validate_tokens(cdef.output.filename, NAME_TOKENS)
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=f"output filename: {exc}") from exc

    # Resolve every table up front: an export artefact with a hole fails
    # LOUDLY (422 naming the entries) rather than shipping a partial zip that
    # looks complete — deliberate divergence from the bundle's
    # tolerant-dangler stance (spec §4.3). Template/folder validation AND
    # per-entry transform resolution (spec §8, Phase 4) are merged into this
    # SAME pass (rather than a second/third loop): each iteration appends
    # EXACTLY ONE slot to `folders` — on success the rendered segments, on a
    # `ValueError` an empty list — and EXACTLY ONE slot to `transform_codes`
    # — the resolved snippet code, or `None` for no-transform/failed
    # resolution — so both stay index-aligned with `cdef.entries` BY
    # CONSTRUCTION on every path, not merely because the `bad_templates`/
    # `bad_transforms` checks below 422 before the later
    # `zip(..., strict=True)` would ever see a misalignment.
    missing: list[str] = []
    bad_templates: list[str] = []
    bad_transforms: list[str] = []
    tables: list[ArtifactRow | None] = []
    folders: list[list[str]] = []
    transform_codes: list[str | None] = []
    for entry in cdef.entries:
        t = content.get_artifact(db, entry.source.ref)
        if t is None or t.project_id != project_id or t.kind is not ArtifactKind.table:
            missing.append(entry.name or entry.source.ref)
            tables.append(None)
            table_name = entry.source.ref
        else:
            tables.append(t)
            table_name = t.name
        # Same up-front, name-the-entry stance as the missing-table check:
        # a bad `${...}` token, an absolute/empty-segment folder, or a
        # tokenless split template must not 422 the whole export
        # anonymously (dialog gating only covers json-mode saves — an entry
        # saved under xlsx then flipped to json can carry a tokenless
        # template).
        segs: list[str] = []
        try:
            validate_tokens(entry.name, NAME_TOKENS)
            validate_tokens(entry.folder, NAME_TOKENS)
            rendered_folder = substitute(entry.folder, {"name": table_name, **ctx})
            segs = folder_segments(rendered_folder)
            split = entry.json_split
            if entry.format in JSON_FAMILY and split is not None and split.enabled:
                validate_template(split.filename_template)
                validate_tokens(split.filename_template, SPLIT_TOKENS)
        except ValueError as exc:
            bad_templates.append(f"{entry.name or entry.source.ref}: {exc}")
            segs = []
        folders.append(segs)
        code_: str | None = None
        if entry.transform is not None:
            label = entry.name or entry.source.ref
            try:
                if entry.format not in JSON_FAMILY:
                    raise ValueError(
                        f"{label}: transform is only supported for JSON-family "
                        f"formats, not {entry.format!r}"
                    )
                code_ = _resolve_transform_code(
                    db, project_id, entry.transform.ref, label
                )
            except ValueError as exc:
                bad_transforms.append(str(exc))
        transform_codes.append(code_)
    if missing:
        raise HTTPException(
            status_code=422,
            detail="missing table(s) for entries: " + ", ".join(missing),
        )
    if bad_templates:
        raise HTTPException(
            status_code=422,
            detail="invalid template for entries: " + ", ".join(bad_templates),
        )
    if bad_transforms:
        raise HTTPException(
            status_code=422,
            detail="invalid transform for entries: " + "; ".join(bad_transforms),
        )

    # A run-level host: `TransformHost` shares one warm SnippetSession per
    # DISTINCT code across every entry that uses it (spec §8), so it is
    # opened ONCE for the whole request — never per entry — and only when at
    # least one entry actually carries a transform (an export with no
    # transforms takes no interactive concurrency slot at all). Mapped to
    # 429/503 here, same as the standalone `/tables/export` route.
    transform_host = None
    if any(c is not None for c in transform_codes):
        try:
            # Two-slot reality: this holds one interactive slot for the
            # whole run's transform calls, while each entry's own
            # `run_table_export` -> `open_script_context` may draw a SECOND
            # slot for that table's script columns. No deadlock — a script
            # context degrades to unavailable/cache-only rather than
            # blocking on a slot — but a transform-bearing export of a
            # scripted table consumes two of `snippet_concurrency`.
            transform_host = open_transform_host(runner, model, settings)
        except TransformUnavailableError as exc:
            raise HTTPException(
                status_code=429 if exc.busy else 503, detail=str(exc)
            ) from exc
    try:
        try:
            results = []
            for entry, t, segments, code_ in zip(
                cdef.entries, tables, folders, transform_codes, strict=True
            ):
                assert t is not None
                defn = _resolve_table(
                    EvaluateTableIn(artifact_id=t.id, offset=0, limit=100),
                    project_id,
                    db,
                )
                out_name = (
                    substitute(entry.name, {"name": t.name, **ctx})
                    if entry.name
                    else t.name
                )
                results.append(
                    (
                        entry,
                        t,
                        segments,
                        out_name,
                        run_table_export(
                            session=session,
                            settings=settings,
                            runner=runner,
                            metamodel=metamodel,
                            model=model,
                            defn=defn,
                            render_defn=overridden_table(defn, entry),
                            name=out_name,
                            format=entry.format,
                            sort=None,
                            template_vars=ctx,
                            json_doc=entry.json_doc,
                            transform_code=code_,
                            transform_host=transform_host,
                        ),
                    )
                )
        except LookupError as exc:
            raise HTTPException(
                status_code=422, detail=f"unknown artifact {exc}"
            ) from exc
        except (NavigationResolveError, ValueError) as exc:
            raise HTTPException(status_code=422, detail=str(exc)) from exc

        pending = [r.status for *_, r in results if isinstance(r, ExportPending)]
        if pending:
            # ONE aggregate 202. Every entry already ran (kicking every pending
            # table's sweep, so they fill concurrently); the retry re-reads the
            # cache. See `_aggregate_pending` for why `computing` wins over
            # `failed`.
            agg = _aggregate_pending(pending)
            return JSONResponse(
                status_code=202,
                content=agg.model_dump(),
                headers={"Retry-After": "1"},
            )

        # Spec §5: the manifest is a zip-mode-only convenience — bare's whole
        # point is exactly one file, so a bare run neither seeds "manifest"
        # against the user's own filename nor injects a second member (which
        # would turn every bare run into the len(files) != 1 422 below).
        want_manifest = cdef.output.manifest and cdef.output.mode == "zip"

        files: list[tuple[str, bytes]] = []
        taken: set[str] = set()
        # Seeded BEFORE assembly so a user entry whose stem renders to
        # "manifest" dedupes to "manifest_2" against the reserved root name —
        # `taken` stores extension-less `prefix + stem` paths (see
        # `_dedupe_path`), so this is the same seeding shape a real entry would
        # produce. Known, accepted consequence: an entry named "manifest"
        # exporting as `.xlsx` still gets suffixed even though `manifest.xlsx`
        # would never collide with `manifest.json` on disk — `taken` is not
        # extension-aware, and it should not be made so for this one case.
        if want_manifest:
            taken.add(MANIFEST_NAME.rpartition(".")[0])
        manifest_entries: list[ManifestEntry] = []
        truncated = degraded = False
        for entry, t, segments, out_name, res in results:
            assert isinstance(res, ExportFiles)
            assert t is not None
            truncated |= res.truncated
            degraded |= res.degraded
            # `prefix` is the entry's user-chosen folder path, ALREADY validated
            # and sanitized segment-by-segment by `folder_segments` in the
            # up-front pass above — it is safe to splice verbatim ahead of the
            # entry's own member name below. Dedupe is scoped to `prefix`
            # (`_dedupe_path` keys on the FULL member path), so two entries
            # landing in different folders never force a suffix on each other.
            prefix = "/".join(segments) + "/" if segments else ""
            if res.archive:
                # A split entry keeps its per-element files together under one
                # folder named by the entry, now nested BENEATH the user
                # folder; root-name collisions within that folder dedupe `_2`.
                # `sanitize_stem` guards the zip-slip boundary here: `out_name`
                # is free-form user text (`entry.name`/`t.name`, no charset
                # constraint at the API layer) that is about to become an
                # archive member's path prefix — `zipfile.ZipInfo` writes
                # whatever it's given verbatim, so an unsanitized `../../evil`
                # would unzip outside the archive root. `sanitize_stem` returns
                # "" for whitespace-only input BY DESIGN (its docstring: callers
                # fall back through `... or fallback or "element"`) — this
                # caller is that fallback site: an empty folder name becomes
                # `f"{prefix}{folder}/{fn}"` with `folder == ""`, which collapses
                # to `{prefix}/{fn}` — an ABSOLUTE member (leading `/`) when
                # `prefix` is itself empty (the no-folder case, still the common
                # one), or a `//` run mid-path when `prefix` is non-empty; both
                # are the same hazard class a naive extractor can misinterpret.
                # The `"export"` fallback keeps this segment non-empty exactly
                # like `prefix`'s own segments already are (guaranteed by
                # `folder_segments`).
                folder = _dedupe_path(
                    prefix, sanitize_stem(out_name) or "export", taken
                )
                entry_paths = [f"{prefix}{folder}/{fn}" for fn, _blob in res.files]
                files.extend(
                    zip(entry_paths, (blob for _fn, blob in res.files), strict=True)
                )
                # Reserve every member this split entry ACTUALLY writes, not
                # merely its `{prefix}{folder}` folder-name slot: `taken` is
                # `_dedupe_path`'s dedupe namespace, and a later entry's own
                # `_dedupe_path` call only ever compares against what's in
                # `taken` — the folder-name reservation above never touched the
                # per-file paths below it, so a sibling entry rendering into
                # `{folder}/` (e.g. an entry with `folder="X"` when this split
                # entry wrote `X/...`) saw no collision and both entries wrote
                # the same zip member. Stored extension-less, matching every
                # other `taken` entry's shape (`_dedupe_path`'s own docstring).
                taken.update(path.rpartition(".")[0] for path in entry_paths)
            else:
                fn, blob = res.files[0]
                stem, dot, ext = fn.rpartition(".")
                # Same zip-slip guard as the branch above: `stem` traces back to
                # the same unsanitized `out_name` (run_table_export names the
                # single-file case `f"{name}.<ext>"`), so it needs the identical
                # treatment before it becomes a zip member's path — including
                # the empty-stem fallback (see comment above). `prefix` needs no
                # further sanitizing here (see the note above the branch).
                deduped = _dedupe_path(prefix, sanitize_stem(stem) or "export", taken)
                entry_paths = [f"{prefix}{deduped}{dot}{ext}"]
                files.append((entry_paths[0], blob))
            if want_manifest:
                manifest_entries.append(
                    ManifestEntry(
                        name=out_name,
                        table_ref=entry.source.ref,
                        table_name=t.name,
                        format=entry.format,
                        truncated=res.truncated,
                        degraded=res.degraded,
                        files=entry_paths,
                        transform=(
                            entry.transform.ref if entry.transform is not None else None
                        ),
                    )
                )

        if want_manifest:
            files.insert(
                0,
                (
                    MANIFEST_NAME,
                    build_manifest(
                        project_id=project_id,
                        artifact_id=artifact_id,
                        artifact_name=run_name,
                        model_rev=session.model_rev,
                        entries=manifest_entries,
                    ),
                ),
            )

        zip_stem = (
            sanitize_stem(substitute(cdef.output.filename, {"name": run_name, **ctx}))
            or sanitize_stem(run_name)
            or "export"
        )
        resp_headers = {"Content-Disposition": f'attachment; filename="{zip_stem}.zip"'}
        if truncated:
            resp_headers["X-Table-Truncated"] = "true"
        if degraded:
            resp_headers["X-Table-Script-Errors"] = "true"

        if cdef.output.mode == "bare":
            # Spec §9.3: bare is a CONTRACT (exactly one file), not best-effort —
            # a silent fallback to zip would change the content type under a
            # consuming script. Never blocks Save; enforced only here.
            if len(files) != 1:
                raise HTTPException(
                    status_code=422,
                    detail=f"bare output requires a single file (this run produced {len(files)})",
                )
            member, blob = files[0]
            ext = member.rpartition(".")[2]
            return Response(
                content=blob,
                media_type=MEDIA_TYPES.get(ext, "application/octet-stream"),
                headers={
                    "Content-Disposition": f'attachment; filename="{member.rpartition("/")[2]}"',
                    **{
                        k: v
                        for k, v in resp_headers.items()
                        if k != "Content-Disposition"
                    },
                },
            )

        return Response(
            content=build_zip(files),
            media_type="application/zip",
            headers=resp_headers,
        )
    finally:
        # Covers the WHOLE run loop + assembly, not just the run loop: the
        # host's sessions are shared across every entry, and the pending/202
        # early return above must close it too (a still-computing export
        # takes the slot for the duration of THIS request only — the next
        # poll opens its own host).
        if transform_host is not None:
            transform_host.close()
