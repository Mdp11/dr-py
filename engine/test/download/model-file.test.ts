import { describe, expect, it } from 'vitest';
import {
	drain,
	Model,
	modelFileSteps,
	PyFloat,
	ReadError,
	type ModelFile,
	type Progress,
	type Steps
} from '../../src/index.ts';
import { thrown } from '../golden/thrown.ts';
import { nodeMetamodel } from '../model/fixtures.ts';
import { clone, workingCopy } from '../working/helpers.ts';
import { fileText } from './helpers.ts';

/** Every step's progress, and the file. */
function stepped(steps: Steps<ModelFile>): { progress: Progress[]; file: ModelFile } {
	const progress: Progress[] = [];
	for (;;) {
		const next = steps.next();
		if (next.done === true) return { progress, file: next.value };
		progress.push(next.value);
	}
}

/** `a`, named, and `b`, bare, with `a` referring to `b`. */
function pair(): Model {
	const model = new Model(nodeMetamodel());
	model.setProperty(model.createElement('Node', 'a'), 'name', 'A');
	model.createElement('Node', 'b');
	model.connect('Refers', 'a', 'b', 'r');
	return model;
}

const PAIR_FILE = `{
  "elements": [
    {
      "id": "a",
      "type_name": "Node",
      "properties": {
        "name": "A"
      },
      "rev": 1
    },
    {
      "id": "b",
      "type_name": "Node",
      "properties": {},
      "rev": 0
    }
  ],
  "relationships": [
    {
      "id": "r",
      "type_name": "Refers",
      "source_id": "a",
      "target_id": "b",
      "properties": {},
      "rev": 0
    }
  ]
}`;

describe('the model file', () => {
	it('is the server file, framed and indented, with no trailing newline', () => {
		const file = drain(modelFileSteps(workingCopy(pair())));
		expect(Object.keys(file)).toEqual(['parts', 'filename', 'content_type']);
		expect(file).toMatchObject({ filename: 'model.json', content_type: 'application/json' });
		expect(fileText(file)).toBe(PAIR_FILE);
	});

	it('writes an empty list without brackets on lines of their own', () => {
		const model = pair();
		model.disconnect('r');
		model.deleteElement('b');
		expect(fileText(drain(modelFileSteps(workingCopy(model))))).toBe(
			'{\n  "elements": [\n    {\n      "id": "a",\n      "type_name": "Node",\n' +
				'      "properties": {\n        "name": "A"\n      },\n      "rev": 1\n    }\n  ],\n' +
				'  "relationships": []\n}'
		);
		model.deleteElement('a');
		expect(fileText(drain(modelFileSteps(workingCopy(model))))).toBe(
			'{\n  "elements": [],\n  "relationships": []\n}'
		);
	});

	it('gives the same bytes in parts of 16', () => {
		const file = drain(modelFileSteps(workingCopy(pair()), 16));
		expect(file.parts.length).toBeGreaterThan(1);
		expect(file.parts.every((part) => part.byteLength <= 16)).toBe(true);
		expect(fileText(file)).toBe(PAIR_FILE);
	});

	it('is the committed file whatever is staged', () => {
		const wc = workingCopy(clone(pair()));
		wc.stage([
			{ kind: 'update_element', id: 'a', properties_patch: { name: 'staged' } },
			{ kind: 'delete_element', id: 'b' },
			{ kind: 'create_element', temp_id: 'tmp_b', type_name: 'Node', properties: {}, id: 'b' },
			{ kind: 'create_element', temp_id: 'tmp_c', type_name: 'Node', properties: {} }
		]);
		expect(fileText(drain(modelFileSteps(wc)))).toBe(PAIR_FILE);
	});

	it('refuses a non-finite float with 422', () => {
		const model = pair();
		model.setProperty(model.getElement('b'), 'name', new PyFloat(Infinity));
		const error = thrown(() => drain(modelFileSteps(workingCopy(model))));
		expect(error).toBeInstanceOf(ReadError);
		expect(error).toMatchObject({
			status: 422,
			detail: 'Out of range float values are not JSON compliant'
		});
	});

	it('refuses a lone surrogate at its place in the file, in code points', () => {
		const model = pair();
		model.setProperty(model.getElement('b'), 'name', '𝄞Ā');
		const text = fileText(drain(modelFileSteps(workingCopy(model))));
		const at = Array.from(text.slice(0, text.indexOf('Ā'))).length;
		model.setProperty(model.getElement('b'), 'name', '𝄞\ud800');
		expect(thrown(() => drain(modelFileSteps(workingCopy(model), 7)))).toMatchObject({
			status: 422,
			detail: `'utf-8' codec can't encode character '\\ud800' in position ${at}: surrogates not allowed`
		});
	});

	it('visits at most 1,024 entities a step, counting every committed one', () => {
		const model = new Model(nodeMetamodel());
		for (let i = 0; i < 2_000; i++) model.createElement('Node', `n${i}`);
		for (let i = 1; i < 1_500; i++) model.connect('Refers', `n${i - 1}`, `n${i}`, `r${i}`);
		const wc = workingCopy(clone(model));
		// Two more entities in the working model, three fewer: the committed count stands.
		wc.stage([
			{ kind: 'create_element', temp_id: 'tmp_x', type_name: 'Node', properties: {} },
			{ kind: 'create_element', temp_id: 'tmp_y', type_name: 'Node', properties: {} },
			{ kind: 'delete_element', id: 'n1999' },
			{ kind: 'delete_relationship', id: 'r1' },
			{ kind: 'delete_relationship', id: 'r2' }
		]);
		const total = 2_000 + 1_499;
		const { progress, file } = stepped(modelFileSteps(wc));
		expect(progress.length).toBe(Math.floor(total / 1_024));
		let done = 0;
		for (const step of progress) {
			expect(step.total).toBe(total);
			expect(step.done - done).toBeLessThanOrEqual(1_024);
			done = step.done;
		}
		expect(fileText(file)).toBe(fileText(drain(modelFileSteps(workingCopy(model)))));
	});
});
