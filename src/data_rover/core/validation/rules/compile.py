"""Rule-set compilation: parse, drift-check, and build the dispatch map.

Compilation is pure and cheap; the output is treated as immutable and cached
on the API Session (immutable-swap — never mutate a published CompiledRules,
except the GIL-atomic `eval_errors` counter the validator increments).

Drift stance: a rule referencing a schema name the metamodel doesn't have is
skipped WHOLE with a diagnostic — never evaluated half-blind, never an error.
"""

from __future__ import annotations

from collections import Counter
from collections.abc import Sequence
from dataclasses import dataclass, field

from ...metamodel.schema import Metamodel
from .schema import (
    AllCond,
    AnyCond,
    Condition,
    NotCond,
    PropertyCond,
    RelationshipCond,
    Rule,
    RuleSetError,
    parse_rule_set,
)


@dataclass(frozen=True)
class RuleSetSource:
    artifact_id: str
    name: str
    yaml: str


@dataclass(frozen=True)
class RuleDiagnostic:
    artifact_id: str
    set_name: str
    #: "" when the whole set failed to parse
    rule: str
    reason: str


@dataclass(frozen=True)
class CompiledRule:
    artifact_id: str
    rule: Rule
    applies_types: frozenset[str]
    check: str


@dataclass
class CompiledRules:
    sources: tuple[RuleSetSource, ...] = ()
    rules: tuple[CompiledRule, ...] = ()
    rules_by_type: dict[str, tuple[CompiledRule, ...]] = field(default_factory=dict)
    skipped: tuple[RuleDiagnostic, ...] = ()
    #: per-rule unexpected-evaluation-failure counts (check name -> count);
    #: mutated by RulesValidator under the callers' locking discipline
    eval_errors: Counter[str] = field(default_factory=Counter)

    @property
    def total(self) -> int:
        return len(self.rules)


def empty_compiled() -> CompiledRules:
    return CompiledRules()


def _drift_reason(rule: Rule, mm: Metamodel) -> str | None:
    """First schema mismatch in the rule, or None when it compiles clean."""
    if not mm.is_element_type(rule.applies_to):
        return f"unknown stereotype {rule.applies_to!r}"

    def props_of(type_name: str | None) -> set[str] | None:
        if type_name is None:
            return None  # unknown context: property names not checkable
        return {p.name for p in mm.effective_element_properties(type_name)}

    def walk(cond: Condition, context: str | None) -> str | None:
        match cond:
            case AllCond(all=subs) | AnyCond(any=subs):
                for c in subs:
                    if (r := walk(c, context)) is not None:
                        return r
            case NotCond(not_=sub):
                return walk(sub, context)
            case PropertyCond():
                known = props_of(context)
                if known is not None and cond.property not in known:
                    return f"stereotype {context!r} has no property {cond.property!r}"
            case RelationshipCond(relationship=spec):
                if mm.relationship_type(spec.type) is None:
                    return f"unknown relationship type {spec.type!r}"
                if spec.to is not None and not mm.is_element_type(spec.to):
                    return f"unknown stereotype {spec.to!r}"
                if spec.where is not None:
                    return walk(spec.where, spec.to)
        return None

    for cond in (rule.when, rule.then):
        if cond is not None and (r := walk(cond, rule.applies_to)) is not None:
            return r
    return None


def compile_rule_sets(
    sources: Sequence[RuleSetSource], metamodel: Metamodel
) -> CompiledRules:
    rules: list[CompiledRule] = []
    skipped: list[RuleDiagnostic] = []
    for src in sources:
        try:
            definition = parse_rule_set(src.yaml)
        except RuleSetError as exc:
            skipped.append(RuleDiagnostic(src.artifact_id, src.name, "", str(exc)))
            continue
        for rule in definition.rules:
            if rule.disabled:
                continue
            reason = _drift_reason(rule, metamodel)
            if reason is not None:
                skipped.append(
                    RuleDiagnostic(src.artifact_id, src.name, rule.name, reason)
                )
                continue
            rules.append(
                CompiledRule(
                    artifact_id=src.artifact_id,
                    rule=rule,
                    applies_types=metamodel.element_descendants(rule.applies_to),
                    check=f"rule:{rule.name}",
                )
            )
    by_type: dict[str, list[CompiledRule]] = {}
    for cr in rules:
        for t in sorted(cr.applies_types):
            by_type.setdefault(t, []).append(cr)
    return CompiledRules(
        sources=tuple(sources),
        rules=tuple(rules),
        rules_by_type={t: tuple(rs) for t, rs in by_type.items()},
        skipped=tuple(skipped),
    )


def applies_type_names(*compiled: CompiledRules) -> set[str]:
    """Union of every compiled rule's applies-to closure (rule-edit rescope)."""
    out: set[str] = set()
    for c in compiled:
        for cr in c.rules:
            out |= cr.applies_types
    return out
