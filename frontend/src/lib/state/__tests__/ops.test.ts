import { describe, expect, it } from 'vitest';
import {
	ARTIFACT_RESOURCE_PREFIX,
	TEMP_ID_PREFIX,
	artifactResource,
	createTempId,
	isArtifactResource,
	isTempId,
	folderResource,
	isFolderResource,
	FOLDER_RESOURCE_PREFIX,
	VIEW_ROOT_ID
} from '../ops';
import type { ArtifactOp, ModelOp, Op, ViewOp } from '../ops';

describe('createTempId', () => {
	it('returns a string that starts with the temp prefix', () => {
		const id = createTempId();
		expect(typeof id).toBe('string');
		expect(id.startsWith(TEMP_ID_PREFIX)).toBe(true);
	});

	it('returns a non-trivial id beyond the prefix', () => {
		const id = createTempId();
		expect(id.length).toBeGreaterThan(TEMP_ID_PREFIX.length + 4);
	});

	it('produces different ids on successive calls', () => {
		const a = createTempId();
		const b = createTempId();
		expect(a).not.toBe(b);
	});
});

describe('isTempId', () => {
	it('returns true for ids with the temp prefix', () => {
		expect(isTempId('tmp_abc')).toBe(true);
		expect(isTempId(createTempId())).toBe(true);
	});

	it('returns false for ids without the temp prefix', () => {
		expect(isTempId('e-1')).toBe(false);
		expect(isTempId('elem-123')).toBe(false);
		expect(isTempId('')).toBe(false);
	});
});

describe('artifact lock namespace', () => {
	it('prefixes artifact ids with art:', () => {
		expect(artifactResource('abc')).toBe('art:abc');
		expect(ARTIFACT_RESOURCE_PREFIX).toBe('art:');
	});
	it('classifies resource ids', () => {
		expect(isArtifactResource('art:abc')).toBe(true);
		expect(isArtifactResource('abc')).toBe(false); // bare element id
	});
	it('artifact ops are assignable to Op but not ModelOp', () => {
		const op: ArtifactOp = { kind: 'delete_artifact', id: 'a1' };
		const asOp: Op = op; // compile-time check
		expect(asOp.kind).toBe('delete_artifact');
		// @ts-expect-error - ArtifactOp is not assignable to ModelOp
		const asModelOp: ModelOp = op;
		void asModelOp;
	});
});

describe('folder lock namespace', () => {
	it('prefixes folder ids with folder:', () => {
		expect(folderResource('f1')).toBe('folder:f1');
		expect(folderResource(VIEW_ROOT_ID)).toBe('folder:root');
		expect(FOLDER_RESOURCE_PREFIX).toBe('folder:');
	});
	it('classifies resource ids', () => {
		expect(isFolderResource('folder:f1')).toBe(true);
		expect(isFolderResource('art:f1')).toBe(false);
		expect(isFolderResource('f1')).toBe(false);
	});
	it('view ops are assignable to Op', () => {
		const op: ViewOp = { kind: 'rename_folder', id: 'f1', name: 'B' };
		const asOp: Op = op; // compile-time check
		expect(asOp.kind).toBe('rename_folder');
	});
});
