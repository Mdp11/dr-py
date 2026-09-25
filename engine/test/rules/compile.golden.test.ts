import { describe, expect, it } from 'vitest';
import { compileRuleSets, Metamodel, type RuleSource } from '../../src/index.ts';
import { loadFixture } from '../golden/load.ts';
import {
	compiledRecord,
	compileRecorded,
	replaySteps,
	rulesStatus,
	type RulesStepResult,
	type StepsFixture
} from '../golden/model-steps.ts';

type CompileFixture = { runs: StepsFixture[] };

describe('rule sets compile as the oracle compiles them', () => {
	const fixture = loadFixture<CompileFixture>('rules_compile');

	it('every construct, parse failures, drift, disabled and abstract rules, twin names', () => {
		for (const run of fixture.runs) replaySteps(run);
	});

	it('the same sources drift differently against another metamodel', () => {
		const [a, b] = fixture.runs.map((run) => {
			const step = run.steps.find((s) => s.do === 'rules')!;
			return compileRecorded(step, Metamodel.fromJSON(run.metamodel));
		});
		expect(a!.total).not.toBe(b!.total);
		expect(a!.skipped).not.toEqual(b!.skipped);
	});

	it('compiles sources handed in directly, in the order given', () => {
		for (const run of fixture.runs) {
			const mm = Metamodel.fromJSON(run.metamodel);
			for (const step of run.steps.filter((s) => s.do === 'rules')) {
				const { parses, status, compiled } = step.result as RulesStepResult;
				const sources: RuleSource[] = step.sources!.map((source, i) => {
					const parse = parses[i]!;
					return {
						artifactId: source.artifact_id,
						name: source.name,
						parse: parse.ok
							? { ok: true, document: parse.document! }
							: { ok: false, errors: parse.errors.map(({ message }) => ({ message })) }
					};
				});
				const out = compileRuleSets(sources, mm);
				expect(JSON.stringify(rulesStatus(out))).toBe(JSON.stringify(status));
				expect(JSON.stringify(compiledRecord(out))).toBe(JSON.stringify(compiled));
				expect(out.identities).toEqual(out.rules.map((rule) => rule.rule.identity));
			}
		}
	});
});
