import { describe, expect, it } from 'vitest';
import {
	applyBatch,
	candidateDiff,
	candidateKey,
	candidateScan,
	candidateStructureSteps,
	compileRuleSets,
	drain,
	FacetPatterns,
	liveStructure,
	Metamodel,
	Model,
	PatternUnusable,
	prepareCandidate,
	PyFloat,
	rebindPreviewBody,
	RulesUnreadable,
	validateScoped,
	validateSplit,
	Validators,
	WholeRun,
	type CompiledRules,
	type Issue,
	type MetamodelDoc,
	type Progress,
	type RuleSource,
	type Structure,
	type Value
} from '../../src/index.ts';
import { loadFixture } from '../golden/load.ts';
import {
	loadModelFile,
	parseOps,
	recordedSources,
	type StepsFixture
} from '../golden/model-steps.ts';
import { NODE_DOC, nodeMetamodel } from '../model/fixtures.ts';

const issue = (message: string, targetIds: string[], extra: Partial<Issue> = {}): Issue => ({
	severity: 'error',
	message,
	targetIds,
	category: 'conformance',
	check: 'uniqueness',
	...extra
});

const allIds = (model: Model) => [
	...[...model.elements()].map((el) => el.id),
	...[...model.relationships()].map((rel) => rel.id)
];

/**
 * The first run of `metamodel_candidate` after its setup: the smart-city
 * example with the batch landed, its rule sources, and the candidate
 * documents by case.
 */
function setUp(): {
	model: Model;
	doc: MetamodelDoc;
	sources: RuleSource[];
	candidates: Map<string, MetamodelDoc>;
} {
	const [run] = loadFixture<{ runs: StepsFixture[] }>('metamodel_candidate').runs;
	const [rules, batch, , ...steps] = run!.steps;
	const model = loadModelFile(run!);
	applyBatch(model, parseOps(batch!.ops!));
	const candidates = new Map(steps.map((step) => [step.case!, step.metamodel!]));
	return { model, doc: run!.metamodel, sources: recordedSources(rules!), candidates };
}

/** One run over the whole model, fed every element then every relationship at once. */
function wholeRun(
	model: Model,
	v: Validators,
	p: FacetPatterns,
	rules: CompiledRules | null,
	structure: Structure
): Issue[] {
	const run = new WholeRun(model, v, p, rules, structure);
	for (const el of model.elements()) run.element(el);
	for (const rel of model.relationships()) run.relationship(rel);
	return run.finish();
}

describe('candidateKey', () => {
	it('sorts the target ids, so their order does not matter', () => {
		const a = issue('m', ['b', 'a', 'Z']);
		expect(candidateKey(a)).toBe(candidateKey(issue('m', ['a', 'Z', 'b'])));
		expect(JSON.parse(candidateKey(a))).toEqual([
			'conformance',
			'error',
			'uniqueness',
			'm',
			['Z', 'a', 'b']
		]);
		expect(a.targetIds).toEqual(['b', 'a', 'Z']);
	});

	it('tells issues apart by category, severity, check and message', () => {
		const base = issue('m', ['a']);
		for (const other of [
			issue('m', ['a'], { category: 'structural' }),
			issue('m', ['a'], { severity: 'warning' }),
			issue('m', ['a'], { check: 'facets' }),
			issue('n', ['a']),
			issue('m', ['a', 'b'])
		]) {
			expect(candidateKey(other)).not.toBe(candidateKey(base));
		}
	});
});

describe('candidateDiff', () => {
	it('keeps a key at its first position with its last value, on either side', () => {
		const current = [issue('dup', ['a', 'b']), issue('gone', ['c']), issue('dup', ['b', 'a'])];
		const candidate = [issue('new', ['d', 'e']), issue('other', ['f']), issue('new', ['e', 'd'])];
		const diff = candidateDiff(current, candidate);
		expect(diff.now_passing.map((i) => [i.message, i.target_ids])).toEqual([
			['dup', ['b', 'a']],
			['gone', ['c']]
		]);
		expect(diff.now_failing.map((i) => [i.message, i.target_ids])).toEqual([
			['new', ['e', 'd']],
			['other', ['f']]
		]);
	});

	it('counts distinct shared keys as unchanged and the raw lists as the error counts', () => {
		const current = [issue('same', ['a']), issue('same', ['a']), issue('gone', ['b'])];
		const candidate = [
			issue('same', ['a']),
			issue('same', ['a']),
			issue('same', ['a']),
			issue('also', ['b'])
		];
		const diff = candidateDiff(current, candidate);
		expect(diff.unchanged_count).toBe(1);
		expect(diff.current_error_count).toBe(3);
		expect(diff.candidate_error_count).toBe(4);
		expect(Object.keys(diff)).toEqual([
			'now_failing',
			'now_passing',
			'unchanged_count',
			'current_error_count',
			'candidate_error_count'
		]);
	});

	it('reads the current side once, as an iterable', () => {
		function* current() {
			yield issue('a', ['x']);
			yield issue('b', ['y']);
		}
		const diff = candidateDiff(current(), [issue('a', ['x'])]);
		expect(diff.current_error_count).toBe(2);
		expect(diff.now_passing.map((i) => i.message)).toEqual(['b']);
	});

	it('answers every issue as the server has it', () => {
		const diff = candidateDiff([issue('a', ['x'])], [issue('b', ['y'], { severity: 'warning' })]);
		expect(diff.now_failing).toEqual([
			{
				severity: 'warning',
				message: 'b',
				target_ids: ['y'],
				category: 'conformance',
				check: 'uniqueness',
				origin: 'on_server'
			}
		]);
		expect(diff.now_passing.map((i) => i.origin)).toEqual(['on_server']);
	});
});

describe('rebindPreviewBody', () => {
	it('counts conformance issues, lists structural ones as blockers, and never blocks', () => {
		const issues = [
			issue('c1', ['a']),
			issue('s1', ['b'], { category: 'structural', check: 'containment' }),
			issue('w1', ['c'], { severity: 'warning', check: 'rule:x' })
		];
		const body = rebindPreviewBody(issues);
		expect(Object.keys(body)).toEqual([
			'conformance_error_count',
			'structural_blockers',
			'issues',
			'would_block'
		]);
		expect(body.conformance_error_count).toBe(2);
		expect(body.structural_blockers.map((i) => i.message)).toEqual(['s1']);
		expect(body.issues.map((i) => [i.message, i.origin])).toEqual([
			['c1', 'on_server'],
			['s1', 'on_server'],
			['w1', 'on_server']
		]);
		expect(body.would_block).toBe(false);
	});
});

describe('a run over the whole model', () => {
	const doc = structuredClone(NODE_DOC);
	doc.elements[0]!.properties.push({ ...doc.elements[0]!.properties[0]!, name: 'size' });
	const scopedAndWhole = (model: Model, check: string) => {
		const mm = model.metamodel;
		const [v, p] = [new Validators(mm), new FacetPatterns(mm)];
		const scoped = validateScoped(model, allIds(model), v, p, null, liveStructure(model));
		const whole = wholeRun(model, v, p, null, liveStructure(model));
		const texts = (issues: Issue[]) =>
			issues.filter((i) => i.check === check).map((i) => i.message);
		return { scoped: texts(scoped), whole: texts(whole) };
	};

	it('reports one containment cycle: the first contained element, in relationship order, on one', () => {
		const model = new Model(Metamodel.fromJSON(doc));
		for (const id of ['a', 'b', 'c', 'd', 'e']) model.createElement('Node', id);
		model.connect('Contains', 'c', 'd', 'c-d');
		model.connect('Contains', 'a', 'b', 'a-b');
		model.connect('Contains', 'd', 'c', 'd-c');
		model.connect('Contains', 'b', 'a', 'b-a');
		model.connect('Contains', 'd', 'e', 'd-e');
		const { scoped, whole } = scopedAndWhole(model, 'containment');
		const cycle = (id: string) => `Containment cycle detected involving element ${id}`;
		expect(scoped).toEqual(['a', 'b', 'c', 'd', 'e'].map(cycle));
		expect(whole).toEqual([cycle('d')]);
	});

	it('reports duplicates group by group, each rendering the key of its second member', () => {
		const keyed = structuredClone(doc);
		keyed.elements[0]!.key = ['size'];
		const model = new Model(Metamodel.fromJSON(keyed));
		const sizes: [string, Value][] = [
			['t-int', 1],
			['u-1', 'u'],
			['t-float', new PyFloat(1)],
			['u-2', 'u'],
			['t-bool', true]
		];
		// The groups interleave: the u group's duplicate comes before the t group's last.
		for (const [id, size] of sizes)
			model.setProperty(model.createElement('Node', id), 'size', size);
		const { scoped, whole } = scopedAndWhole(model, 'uniqueness');
		expect(scoped).toEqual([
			'Duplicate Node element t-float: matches t-int (size=1.0)',
			"Duplicate Node element u-2: matches u-1 (size='u')",
			'Duplicate Node element t-bool: matches t-int (size=True)'
		]);
		expect(whole).toEqual([
			'Duplicate Node element t-float: matches t-int (size=1.0)',
			'Duplicate Node element t-bool: matches t-int (size=1.0)',
			"Duplicate Node element u-2: matches u-1 (size='u')"
		]);
	});

	it('refuses validators built for another metamodel', () => {
		const { model } = setUp();
		const mm = model.metamodel;
		const other = nodeMetamodel();
		expect(
			() =>
				new WholeRun(
					model,
					new Validators(mm),
					new FacetPatterns(other),
					null,
					liveStructure(model)
				)
		).toThrow('validators built for another metamodel');
	});
});

describe('candidateScan', () => {
	const { model, doc, sources, candidates } = setUp();

	it('under the live metamodel and rules, answers one unsliced run over the whole model', () => {
		const mm = model.metamodel;
		const [v, p] = [new Validators(mm), new FacetPatterns(mm)];
		const expected = wholeRun(model, v, p, compileRuleSets(sources, mm), liveStructure(model));
		// Its entity issues are the scoped pass's over every id.
		const { entity } = validateSplit(
			model,
			allIds(model),
			v,
			p,
			compileRuleSets(sources, mm),
			liveStructure(model)
		);
		expect(expected.slice(0, entity.length)).toEqual(entity);
		expect(expected.some((i) => i.check === 'uniqueness')).toBe(true);
		expect(expected.some((i) => i.check.startsWith('rule:'))).toBe(true);
		for (const step of [1, 7, 512]) {
			const candidate = prepareCandidate(doc, (cmm) => compileRuleSets(sources, cmm));
			expect(candidate.metamodel).not.toBe(mm);
			expect(drain(candidateScan(model, candidate, step)), `step ${step}`).toEqual(expected);
		}
	});

	it('under a candidate, answers one unsliced run over the whole model, whatever the step', () => {
		const prepare = () =>
			prepareCandidate(candidates.get('containment')!, (mm) => compileRuleSets(sources, mm));
		const c = prepare();
		const structure = drain(candidateStructureSteps(model, c.metamodel));
		const expected = wholeRun(model, c.validators, c.patterns, c.rules, structure);
		// Both global hooks answer, and the containment one once for the model.
		const cycles = expected.filter((i) => i.message.startsWith('Containment cycle'));
		expect(cycles.map((i) => i.targetIds)).toEqual([['fr-e']]);
		expect(expected.some((i) => i.check === 'uniqueness')).toBe(true);
		for (const step of [1, 7, 512, 1_000_000]) {
			expect(drain(candidateScan(model, prepare(), step)), `step ${step}`).toEqual(expected);
		}
	});

	it('reports progress that only grows and ends at its total', () => {
		const c = prepareCandidate(candidates.get('key')!, (mm) => compileRuleSets(sources, mm));
		const progress: Progress[] = [];
		const steps = candidateScan(model, c, 7);
		for (let next = steps.next(); next.done !== true; next = steps.next()) {
			progress.push(next.value);
		}
		const total = progress[0]!.total;
		const entities = model.elementCount + model.relationshipCount;
		expect(total).toBeGreaterThan(entities);
		expect(progress.every((p) => p.total === total)).toBe(true);
		expect(progress.every((p, i) => i === 0 || progress[i - 1]!.done < p.done)).toBe(true);
		expect(progress.at(-1)!.done).toBe(total);
		// The slices: one step per seven ids after the structure is built.
		expect(progress.filter((p) => p.done > total - entities).length).toBe(Math.ceil(entities / 7));
	});

	it('answers an empty model with the structure step alone', () => {
		const empty = loadModelFile({ metamodel: doc, steps: [] });
		const c = prepareCandidate(doc, (mm) => compileRuleSets([], mm));
		const steps = candidateScan(empty, c);
		const progress: Progress[] = [];
		let next = steps.next();
		for (; next.done !== true; next = steps.next()) progress.push(next.value);
		expect(next.value).toEqual([]);
		expect(progress).toEqual([{ done: 1, total: 1 }]);
	});
});

describe('prepareCandidate', () => {
	const { doc } = setUp();

	it('builds the validators, the patterns and the rules over the one metamodel it reads', () => {
		let seen = null;
		const c = prepareCandidate(doc, (mm) => {
			seen = mm;
			return compileRuleSets([], mm);
		});
		expect(seen).toBe(c.metamodel);
		expect(c.validators.metamodel).toBe(c.metamodel);
		expect(c.patterns.metamodel).toBe(c.metamodel);
		expect(c.rules?.total).toBe(0);
	});

	it('throws PatternUnusable on a pattern the host cannot run', () => {
		const unusable = structuredClone(doc);
		const withPattern = unusable.elements.find((type) =>
			type.properties.some((prop) => prop.pattern !== null)
		)!;
		withPattern.properties.find((prop) => prop.pattern !== null)!.pattern = '(?x)a';
		expect(() => prepareCandidate(unusable, (mm) => compileRuleSets([], mm))).toThrow(
			PatternUnusable
		);
	});

	it('throws RulesUnreadable when the rules cannot be read', () => {
		const unreadable = [{ artifactId: 'r-1', name: 'R', parse: null }];
		expect(() => prepareCandidate(doc, (mm) => compileRuleSets(unreadable, mm))).toThrow(
			RulesUnreadable
		);
	});

	it('throws on a malformed document', () => {
		expect(() => prepareCandidate({}, (mm) => compileRuleSets([], mm))).toThrow();
		expect(() => prepareCandidate(null, (mm) => compileRuleSets([], mm))).toThrow();
	});
});
