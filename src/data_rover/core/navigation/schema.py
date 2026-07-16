"""Navigation definitions: walk chains of relationships from a filtered
start set, or combine navigation results with set operations.

Format contract (Stage 1 of the navigation/tables/diagrams mega-plan):

- The document is VERSIONED (`schema_version`) and branch-READY: every
  relationship step carries a `children` slot so branching can be added later
  without migrating saved artifacts — but v2 validation rejects non-empty
  `children` (linear chains only) and caps a definition's total step items at
  MAX_STEPS.
- Filters reuse the advanced-search criterion vocabulary
  (`core.search.criteria`) verbatim, so a navigation filter and a search
  criterion are the same wire object.
- CHAIN CONVENTION: an evaluated chain includes its start element at index 0
  (a path with N *relationship or property* steps yields chains of length N+1 — a
  `FilterStep` prunes the frontier in place and adds no column).
  `Operand.step_index` addresses that tuple directly: 0 = start elements,
  k = elements after relationship-step k, None = terminal step.
- Set operations act on ELEMENT SETS (the elements a navigation reaches at
  one step), never on chain tuples; `difference` is a left fold over the
  operand list.

Definitions are stored as `kind="navigation"` project artifacts; `Operand.ref`
holds such an artifact's id and is inlined by `core.navigation.resolve` before
evaluation (the evaluator itself never sees a ref).
"""

from __future__ import annotations

from typing import Annotated, Literal, Optional, Union

from pydantic import BaseModel, Field, TypeAdapter, model_validator

from data_rover.core.search.criteria import Criterion

SCHEMA_VERSION = 3
#: hard ceiling on chain length; also the recursion depth of the evaluator.
MAX_STEPS = 10


class Scope(BaseModel):
    """An element filter: any of `types` (subtype-inclusive; empty = every
    type) AND all of `criteria`."""

    kind: Literal["scope"] = "scope"
    types: list[str] = Field(default_factory=list)
    criteria: list[Criterion] = Field(default_factory=list)


class RelationshipStep(BaseModel):
    """A hop: traverse `relationship_type` (subtype-inclusive) in `direction`,
    landing on `target_types` (subtype-inclusive; empty = any). Carries NO
    criteria — filtering lives in `FilterStep`. `children` is reserved for
    post-Stage-1 branching and MUST be empty in schema v2."""

    kind: Literal["relationship"] = "relationship"
    relationship_type: str
    direction: Literal["out", "in", "either"] = "out"
    target_types: list[str] = Field(default_factory=list)
    children: list["StepItem"] = Field(default_factory=list)
    #: free-form user note explaining the step's intent (UI-only; the
    #: evaluator ignores it).
    comment: Optional[str] = None

    @model_validator(mode="after")
    def _v2_is_linear(self) -> "RelationshipStep":
        if self.children:
            raise ValueError(
                "branching steps (`children`) are not supported in schema v2"
            )
        return self


class FilterStep(BaseModel):
    """Prunes the current frontier in place: keep an element iff it matches
    ALL criteria. Adds no chain column (see the evaluator). Criteria reuse the
    shared search vocabulary; property criteria are existence-gated at
    evaluation time."""

    kind: Literal["filter"] = "filter"
    criteria: list[Criterion] = Field(default_factory=list)
    #: free-form user note explaining the step's intent (UI-only; the
    #: evaluator ignores it).
    comment: Optional[str] = None


class PropertyStep(BaseModel):
    """A hop through an element-reference property: for each frontier element,
    follow `property_name`'s value(s) — element ids — to the referenced
    element(s). Adds ONE chain column, exactly like a RelationshipStep.

    Per element, the hop applies only when the element's EFFECTIVE property
    def exists and its datatype is an element type; otherwise that chain is
    pruned — graceful, mirroring FilterStep's existence-gating, so the engine
    never raises on odd models. Dangling ids are skipped."""

    kind: Literal["property"] = "property"
    property_name: str
    #: free-form user note explaining the step's intent (UI-only; the
    #: evaluator ignores it).
    comment: Optional[str] = None


StepItem = Annotated[Union[RelationshipStep, FilterStep, PropertyStep], Field(discriminator="kind")]


class PathNavigation(BaseModel):
    kind: Literal["path"]
    schema_version: int = SCHEMA_VERSION
    #: user-chosen display name; None keeps the UI's automatic lettering
    #: ("Path A", "Path B", ...). UI-only — the evaluator ignores it.
    name: Optional[str] = None
    start: "StartNode"
    steps: list[StepItem] = Field(default_factory=list)
    #: cycle guard: when True (default, prior behavior), a chain skips any
    #: element already in its own prefix; when False, chains may revisit
    #: elements (still terminates — chain length is capped at len(steps)+1).
    exclude_visited: bool = True

    @model_validator(mode="after")
    def _cap_steps(self) -> "PathNavigation":
        if len(self.steps) > MAX_STEPS:
            raise ValueError(f"a navigation may have at most {MAX_STEPS} steps")
        return self


class Operand(BaseModel):
    """One input to a set operation: a saved navigation (`ref` = artifact id)
    XOR an inline `definition`, contributing its elements at `step_index`
    (see the chain convention in the module docstring)."""

    ref: Optional[str] = None
    definition: Optional["NavigationDefinition"] = None
    step_index: Optional[int] = Field(default=None, ge=0)

    @model_validator(mode="after")
    def _exactly_one_source(self) -> "Operand":
        if (self.ref is None) == (self.definition is None):
            raise ValueError("an operand needs exactly one of `ref` / `definition`")
        return self


class SetExpression(BaseModel):
    kind: Literal["set_op"]
    schema_version: int = SCHEMA_VERSION
    op: Literal["union", "intersection", "difference", "symmetric_difference"]
    operands: list[Operand] = Field(min_length=1)


class RowStart(BaseModel):
    """Start = the element(s) this navigation is rooted at by its caller.

    Only meaningful when `evaluate()` is given a row binding (table columns
    supply one per row). Reaching a RowStart with no binding is a ValueError:
    a row-rooted definition is not evaluable on its own."""

    kind: Literal["row"] = "row"


StartNode = Annotated[
    Union[Scope, SetExpression, RowStart], Field(discriminator="kind")
]
NavigationDefinition = Annotated[
    Union[PathNavigation, SetExpression], Field(discriminator="kind")
]

RelationshipStep.model_rebuild()
FilterStep.model_rebuild()
PropertyStep.model_rebuild()
PathNavigation.model_rebuild()
Operand.model_rebuild()
SetExpression.model_rebuild()

#: validates/dumps a full definition document (artifact payloads, API bodies).
NAVIGATION_ADAPTER: TypeAdapter[NavigationDefinition] = TypeAdapter(
    NavigationDefinition
)
