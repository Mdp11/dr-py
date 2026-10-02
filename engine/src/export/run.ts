/**
 * `POST /exports/run` in steps: an exporter's entries, each one table's
 * export rendered through the entry's presentation, assembled into one zip
 * led by the manifest — or, `bare`, the run's one file alone.
 */
import type { EvalContext } from '../evaluate/index.ts';
import { Meter, NavKeyError, NavValueError } from '../navigation/evaluate.ts';
import { ReadError } from '../read/errors.ts';
import type { ReadParams } from '../read/params.ts';
import type { Steps } from '../steps/steps.ts';
import { resolveTransformSource, transformSyntaxRefusal } from '../script/snippets.ts';
import { answered, resolved } from '../table/route.ts';
import type { TableDefinition } from '../table/schema.ts';
import { pyRepr } from '../value/repr.ts';
import {
	MANIFEST_NAME,
	manifestTransform,
	renderManifest,
	type ManifestEntry
} from './manifest.ts';
import {
	FolderPathError,
	folderSegments,
	NAME_TOKENS,
	sanitizeStem,
	substitute,
	TakenNames,
	validateTokens
} from './naming.ts';
import {
	exportContext,
	exportFilesSteps,
	isJsonFamily,
	MEDIA_TYPES,
	shipped,
	splitRefusal,
	templateVars,
	transformFormatRefusal,
	type ExportFileResult,
	type ExportFiles,
	type ResolvedTransform
} from './route.ts';
import { TransformSyntaxError } from './transform.ts';
import {
	hasEntryTransform,
	overriddenTable,
	readExporterDefinition,
	type ExporterDefinition,
	type ExporterEntry
} from './schema.ts';
import { zipSteps, type ZipFile } from './zip.ts';

/** Who runs: the saved exporter's id (`null` for a draft) and name, and the call's context. */
export type RunIdentity = {
	artifactId: string | null;
	name: string;
	date: string;
	project: string;
};

/** `str.rpartition`. */
function rpartition(text: string, sep: string): [string, string, string] {
	const at = text.lastIndexOf(sep);
	return at === -1 ? ['', '', text] : [text.slice(0, at), sep, text.slice(at + sep.length)];
}

/**
 * `stem`, or `stem_2`, `stem_3`, … — the first whose `prefix + stem` no
 * member so far has taken, extension aside — taken in turn.
 */
function dedupePath(prefix: string, stem: string, taken: TakenNames): string {
	return taken.claim(prefix + stem).slice(prefix.length);
}

/**
 * An entry's folder as path segments, its name, folder and split templates
 * checked in the route's order — or the core's refusal of the first bad one.
 */
function entrySegments(
	entry: ExporterEntry,
	tableName: string,
	vars: Readonly<Record<string, string>>
): string[] | string {
	const badToken =
		validateTokens(entry.name, NAME_TOKENS) ?? validateTokens(entry.folder, NAME_TOKENS);
	if (badToken !== null) return badToken;
	let segments: string[];
	try {
		segments = folderSegments(substitute(entry.folder, { name: tableName, ...vars }));
	} catch (error) {
		if (error instanceof FolderPathError) return error.message;
		throw error;
	}
	return splitRefusal(entry.format, entry.json_split) ?? segments;
}

/**
 * The code of an entry's transform, or `null` for an entry with none: an entry whose
 * transform is on a format that is not JSON-family, or does not resolve, is listed in `bad`.
 */
function entryTransform(
	ctx: EvalContext,
	entry: ExporterEntry,
	label: string,
	bad: string[]
): ResolvedTransform | null {
	if (!hasEntryTransform(entry)) return null;
	if (!isJsonFamily(entry.format)) {
		bad.push(transformFormatRefusal(label, entry.format).detail);
		return null;
	}
	try {
		return {
			code: resolveTransformSource(ctx.artifacts, entry.transform!, label),
			syntaxRefusal: transformSyntaxRefusal(entry.transform!, label)
		};
	} catch (error) {
		if (error instanceof ReadError) {
			bad.push(error.detail);
			return null;
		}
		throw error;
	}
}

/** An entry as the run renders it, or the refusal its table's resolution met. */
type Planned = {
	entry: ExporterEntry;
	transform: ResolvedTransform | null;
	tableName: string;
	segments: string[];
	outName: string;
	files: Steps<ExportFiles> | ReadError;
};

/**
 * `_execute_export` in steps, in its order. Before the first step: no entries,
 * the output filename's tokens, and the missing tables and bad templates, each
 * list a 422 naming its entries. A table's resolution that fails refuses when
 * the run reaches its entry, as the route's does. An entry's transform runs,
 * and the entries whose transform is on a format that is not JSON-family or
 * does not resolve are one more list, a 422 after the others. `${rev}` and
 * the manifest's `model_rev` are the committed rev.
 */
export function runExportSteps(
	ctx: EvalContext,
	def: ExporterDefinition,
	run: RunIdentity
): Steps<ExportFileResult> {
	if (def.entries.length === 0) throw new ReadError(422, 'exporter has no entries');
	const vars = templateVars(ctx, run);
	const badFilename = validateTokens(def.output.filename, NAME_TOKENS);
	if (badFilename !== null) throw new ReadError(422, `output filename: ${badFilename}`);

	const missing: string[] = [];
	const badTemplates: string[] = [];
	const badTransforms: string[] = [];
	const found = def.entries.map((entry) => {
		const label = entry.name || entry.source.ref;
		const table = ctx.artifacts.resolve(entry.source.ref);
		const isTable = table !== null && table.kind === 'table';
		if (!isTable) missing.push(label);
		const tableName = isTable ? table.name : entry.source.ref;
		const segments = entrySegments(entry, tableName, vars);
		if (typeof segments === 'string') badTemplates.push(`${label}: ${segments}`);
		return {
			entry,
			tableName,
			segments: typeof segments === 'string' ? [] : segments,
			transform: entryTransform(ctx, entry, label, badTransforms)
		};
	});
	if (missing.length > 0) {
		throw new ReadError(422, `missing table(s) for entries: ${missing.join(', ')}`);
	}
	if (badTemplates.length > 0) {
		throw new ReadError(422, `invalid template for entries: ${badTemplates.join(', ')}`);
	}
	if (badTransforms.length > 0) {
		throw new ReadError(422, `invalid transform for entries: ${badTransforms.join('; ')}`);
	}

	const tables = found.map(({ entry }): TableDefinition | ReadError => {
		try {
			return resolved(ctx.artifacts, entry.source.ref);
		} catch (error) {
			if (error instanceof ReadError) return error;
			throw error;
		}
	});

	const modelRev = ctx.working?.rev ?? 0;
	const meter = new Meter(0);
	const planned = found.map(({ entry, tableName, segments, transform }, i): Planned => {
		const defn = tables[i]!;
		const outName = entry.name ? substitute(entry.name, { name: tableName, ...vars }) : tableName;
		const files =
			defn instanceof ReadError
				? defn
				: exportFilesSteps(
						ctx,
						{
							defn,
							renderDefn: overriddenTable(defn, entry),
							name: outName,
							format: entry.format,
							vars,
							jsonDoc: entry.json_doc,
							transform
						},
						meter
					);
		return { entry, transform, tableName, segments, outName, files };
	});

	return answered(
		(function* (): Steps<ExportFileResult> {
			const results: ExportFiles[] = [];
			// The oracle refuses every entry whose transform does not compile before it runs one,
			// all in one list; the guest reports it when the call runs, so a run that has
			// transforms goes on past an entry's failure to find the others, and fails with the
			// list, else with the first failure. A later entry's failure never replaces it: the
			// oracle stops at the first and never reaches the rest.
			const deferring = planned.some(({ transform }) => transform !== null);
			const syntax: string[] = [];
			let first: { readonly error: unknown } | null = null;
			for (const { files } of planned) {
				try {
					if (files instanceof ReadError) throw files;
					results.push(yield* files);
				} catch (error) {
					// Only a refusal is deferred; `answered` turns the core's `ValueError` and `KeyError` into one.
					const refusal =
						error instanceof ReadError ||
						error instanceof NavValueError ||
						error instanceof NavKeyError;
					if (!deferring || !refusal) throw error;
					if (error instanceof TransformSyntaxError) syntax.push(error.detail);
					else first ??= { error };
				}
			}
			if (syntax.length > 0) {
				throw new ReadError(422, `invalid transform for entries: ${syntax.join('; ')}`);
			}
			if (first !== null) throw first.error;
			return yield* assembled(def, run, modelRev, planned, results, vars, meter);
		})()
	);
}

/** The run's files placed and packaged: a zip led by the manifest, or the one file of a bare run. */
function* assembled(
	def: ExporterDefinition,
	run: RunIdentity,
	modelRev: number,
	planned: readonly Planned[],
	results: readonly ExportFiles[],
	vars: Readonly<Record<string, string>>,
	meter: Meter
): Steps<ExportFileResult> {
	const wantManifest = def.output.manifest && def.output.mode === 'zip';
	const files: ZipFile[] = [];
	const taken = new TakenNames();
	if (wantManifest) taken.add(rpartition(MANIFEST_NAME, '.')[0]);
	const manifestEntries: ManifestEntry[] = [];
	let truncated = false;
	let degraded = false;
	for (const [i, { entry, tableName, segments, outName }] of planned.entries()) {
		const res = results[i]!;
		truncated ||= res.truncated;
		degraded ||= res.degraded;
		const prefix = segments.length > 0 ? segments.join('/') + '/' : '';
		let paths: string[];
		if (res.archive && !entry.split_folder) {
			paths = res.files.map(({ path }) => {
				const [stem, dot, ext] = rpartition(path, '.');
				return `${prefix}${dedupePath(prefix, sanitizeStem(stem) || 'export', taken)}${dot}${ext}`;
			});
		} else if (res.archive) {
			const folder = dedupePath(prefix, sanitizeStem(outName) || 'export', taken);
			paths = res.files.map(({ path }) => `${prefix}${folder}/${path}`);
			for (const path of paths) taken.add(rpartition(path, '.')[0]);
		} else {
			const [stem, dot, ext] = rpartition(res.files[0]!.path, '.');
			paths = [`${prefix}${dedupePath(prefix, sanitizeStem(stem) || 'export', taken)}${dot}${ext}`];
		}
		res.files.forEach(({ bytes }, k) => files.push({ path: paths[k]!, bytes }));
		if (wantManifest) {
			manifestEntries.push({
				name: outName,
				table_ref: entry.source.ref,
				table_name: tableName,
				format: entry.format,
				truncated: res.truncated,
				degraded: res.degraded,
				files: paths,
				transform: manifestTransform(entry.transform)
			});
		}
	}
	if (wantManifest) {
		const bytes = renderManifest({
			projectId: run.project,
			artifactId: run.artifactId,
			artifactName: run.name,
			modelRev,
			entries: manifestEntries
		});
		files.unshift({ path: MANIFEST_NAME, bytes });
	}

	if (def.output.mode === 'bare') {
		if (files.length !== 1) {
			throw new ReadError(
				422,
				`bare output requires a single file (this run produced ${files.length})`
			);
		}
		const { path, bytes } = files[0]!;
		const ext = rpartition(path, '.')[2];
		const contentType = Object.hasOwn(MEDIA_TYPES, ext)
			? MEDIA_TYPES[ext as keyof typeof MEDIA_TYPES]
			: 'application/octet-stream';
		return shipped(bytes, rpartition(path, '/')[2], contentType, truncated, degraded);
	}
	const zipStem =
		sanitizeStem(substitute(def.output.filename, { name: run.name, ...vars })) ||
		sanitizeStem(run.name) ||
		'export';
	const zipped = yield* zipSteps(files, meter);
	return shipped(zipped, `${zipStem}.zip`, 'application/zip', truncated, degraded);
}

// -- the route -------------------------------------------------------------------

/**
 * `POST /exports/run`, for a saved exporter (`artifact_id`, read through the
 * working copy's artifacts, so a staged exporter is the one that runs) or a
 * draft (`definition`, named by `name`, else `export`): exactly one of them,
 * with `date` and `project`. Its tables resolve through the same artifacts,
 * so a staged table edit is what the run holds. See `runExportSteps`.
 */
export function runExporter(ctx: EvalContext, params: ReadParams): Steps<ExportFileResult> {
	const { artifact_id: artifactId = null, definition = null, name = '' } = params;
	const draft = definition === null ? null : readExporterDefinition(definition, 'definition');
	if (artifactId !== null && typeof artifactId !== 'string') {
		throw new ReadError(422, 'artifact_id must be a string or null');
	}
	if (typeof name !== 'string') throw new ReadError(422, 'name must be a string');
	const context = exportContext(params);
	if ((artifactId === null) === (draft === null)) {
		throw new ReadError(422, 'exactly one of artifact_id and definition is required');
	}
	if (draft !== null) {
		return runExportSteps(ctx, draft, { artifactId: null, name: name || 'export', ...context });
	}
	const artifact = ctx.artifacts.resolve(artifactId as string);
	if (artifact === null || artifact.kind !== 'exporter') {
		throw new ReadError(404, `unknown exporter ${artifactId as string}`);
	}
	const saved = readExporterDefinition(artifact.payload, `artifact ${pyRepr(artifact.id)}`);
	return runExportSteps(ctx, saved, { artifactId: artifact.id, name: artifact.name, ...context });
}

/** `POST /exports/run` with a draft `definition`: the same route as `runExporter`. */
export const runExporterDraft = runExporter;
