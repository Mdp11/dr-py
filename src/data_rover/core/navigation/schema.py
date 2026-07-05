"""Navigation definitions: walk chains of relationships from a filtered
start set, or combine navigation results with set operations.

Format contract (Stage 1 of the navigation/tables/diagrams mega-plan):

- The document is VERSIONED (`schema_version`) and branch-READY: every step
  carries a `children` slot so branching can be added later without migrating
  saved artifacts — but v1 validation rejects non-empty `children` (linear
  chains only) and caps chains at MAX_STEPS.
- Filters reuse the advanced-search criterion vocabulary
  (`core.search.criteria`) verbatim, so a navigation filter and a search
  criterion are the same wire object.
- CHAIN CONVENTION: an evaluated chain includes its start element at index 0
  (a path with N steps yields chains of length N+1). `Operand.step_index`
  addresses that tuple directly: 0 = start elements, k = elements after step
  k, None = terminal step.
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

SCHEMA_VERSION = 1
#: hard ceiling on chain length; also the recursion depth of the evaluator.
MAX_STEPS = 10


class Scope(BaseModel):
    """An element filter: any of `types` (subtype-inclusive; empty = every
    type) AND all of `criteria`."""

    kind: Literal["scope"] = "scope"
    types: list[str] = Field(default_factory=list)
    criteria: list[Criterion] = Field(default_factory=list)


class Step(BaseModel):
    relationship_type: str
    direction: Literal["out", "in", "either"] = "out"
    target: Scope = Field(default_factory=Scope)
    #: reserved for post-Stage-1 branching; MUST be empty in schema v1.
    children: list["Step"] = Field(default_factory=list)

    @model_validator(mode="after")
    def _v1_is_linear(self) -> "Step":
        if self.children:
            raise ValueError(
                "branching steps (`children`) are not supported in schema v1"
            )
        return self


class PathNavigation(BaseModel):
    kind: Literal["path"]
    schema_version: int = SCHEMA_VERSION
    start: "StartNode"
    steps: list[Step] = Field(default_factory=list)

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


StartNode = Annotated[Union[Scope, SetExpression], Field(discriminator="kind")]
NavigationDefinition = Annotated[
    Union[PathNavigation, SetExpression], Field(discriminator="kind")
]

Step.model_rebuild()
PathNavigation.model_rebuild()
Operand.model_rebuild()
SetExpression.model_rebuild()

#: validates/dumps a full definition document (artifact payloads, API bodies).
NAVIGATION_ADAPTER: TypeAdapter[NavigationDefinition] = TypeAdapter(
    NavigationDefinition
)
