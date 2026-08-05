"""Artifact-op plumbing (Phase 1 artefacts revamp).

Artifacts are materialized DB rows, not model content, so their ops must
never reach the model applier (routes/ops.py::_apply_one). ``split_ops`` is
the single chokepoint every batch passes through; the applier itself lands
with the commit wiring (see this module's growth in the same plan)."""

from __future__ import annotations

from collections.abc import Sequence

from .schemas import (
    ArtifactOpIn,
    CreateArtifactOp,
    DeleteArtifactOp,
    ModelOpIn,
    OpIn,
    UpdateArtifactOp,
)

#: kind-tags of artifact ops, for raw journal dicts (Commit.ops JSON).
ARTIFACT_OP_KINDS = frozenset({"create_artifact", "update_artifact", "delete_artifact"})


def split_ops(ops: Sequence[OpIn]) -> tuple[list[ModelOpIn], list[ArtifactOpIn]]:
    """Separate a mixed batch into (model ops, artifact ops), order-preserving
    within each family. The families are independent (artifact payloads may
    REFERENCE model ids, but tolerantly), so relative cross-family order
    carries no meaning."""
    model_ops: list[ModelOpIn] = []
    artifact_ops: list[ArtifactOpIn] = []
    for op in ops:
        if isinstance(op, (CreateArtifactOp, UpdateArtifactOp, DeleteArtifactOp)):
            artifact_ops.append(op)
        else:
            model_ops.append(op)
    return model_ops, artifact_ops
