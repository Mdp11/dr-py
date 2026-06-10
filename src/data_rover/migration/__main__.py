"""CLI: migrate a paired old-format metamodel + model to the new format.

Usage:
    python -m data_rover.migration \\
        --old-metamodel old.metamodel.json --old-model old.model.json \\
        --out-metamodel new.metamodel.yaml --out-model new.model.json \\
        [--emit-unmapped-links]
"""

from __future__ import annotations

import argparse

from .legacy import migrate_files


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="data_rover.migration")
    parser.add_argument("--old-metamodel", required=True)
    parser.add_argument("--old-model", required=True)
    parser.add_argument("--out-metamodel", required=True)
    parser.add_argument("--out-model", required=True)
    parser.add_argument(
        "--emit-unmapped-links",
        action="store_true",
        help="Emit owner/element_type links even when no metamodel mapping "
        "permits them (default: skip and warn).",
    )
    parser.add_argument(
        "--remove-inconsistencies",
        action="store_true",
        help="Remove model entities that would block frontend loading "
        "(unknown/abstract element type, duplicate ids, relationships with an "
        "unknown type or dangling source/target). Removed entities are written "
        "to a sibling <out-model>.removed.txt for review.",
    )
    args = parser.parse_args(argv)

    report = migrate_files(
        args.old_metamodel,
        args.old_model,
        args.out_metamodel,
        args.out_model,
        emit_unmapped_links=args.emit_unmapped_links,
        remove_inconsistencies=args.remove_inconsistencies,
        progress=print,
    )

    result = report.result
    print()
    print(f"Wrote metamodel -> {args.out_metamodel}")
    print(f"Wrote model     -> {args.out_model}")
    print(
        f"  elements: {len(result.model['elements'])}  "
        f"relationships: {len(result.model['relationships'])}"
    )

    if report.removed:
        print(
            f"\nRemoved {len(report.removed)} inconsistent entit"
            f"{'y' if len(report.removed) == 1 else 'ies'} "
            f"(see {report.removed_report_path}):"
        )
        for r in report.removed:
            print(f"  - [{r.kind}] {r.id} ({r.type_name}): {r.reason}")

    if result.warnings:
        print(f"\nMigration warnings ({len(result.warnings)}):")
        for w in result.warnings:
            print(f"  - {w}")

    if report.metamodel_errors:
        print(f"\nMetamodel check errors ({len(report.metamodel_errors)}):")
        for e in report.metamodel_errors:
            print(f"  - {e}")

    if report.model_issues:
        print(f"\nModel validation issues ({len(report.model_issues)}):")
        for issue in report.model_issues:
            print(f"  - [{issue.severity.value}] {issue.message}")

    if not (report.metamodel_errors or report.model_issues):
        print("\nNo metamodel or model validation issues.")

    return 0


if __name__ == "__main__":  # pragma: no cover
    raise SystemExit(main())
