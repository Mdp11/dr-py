import { flushSync, mount, unmount } from 'svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { EditorView } from '@codemirror/view';
import { diagnosticCount, forEachDiagnostic } from '@codemirror/lint';

import MetamodelYamlEditor from '../MetamodelYamlEditor.svelte';
import MetamodelYamlEditorHost from './MetamodelYamlEditorHost.svelte';
import type { MetamodelLintError } from '$lib/api/types';

afterEach(() => {
	document.body.innerHTML = '';
});

function findView(): EditorView {
	const content = document.querySelector(
		'[data-testid="metamodel-editor"] .cm-content'
	) as HTMLElement;
	const view = EditorView.findFromDOM(content);
	if (!view) throw new Error('CodeMirror view not found in the DOM');
	return view;
}

describe('MetamodelYamlEditor', () => {
	it('renders the document', () => {
		const onChange = vi.fn();
		const c = mount(MetamodelYamlEditor, {
			target: document.body,
			props: { code: 'elements: []\n', onChange }
		});
		flushSync();
		try {
			const host = document.querySelector('[data-testid="metamodel-editor"]');
			expect(host).not.toBeNull();
			expect(host!.textContent).toContain('elements');
		} finally {
			unmount(c);
		}
	});

	it('typing in the editor reports the edit via onChange with the full document text', () => {
		const onChange = vi.fn();
		const c = mount(MetamodelYamlEditor, {
			target: document.body,
			props: { code: 'elements: []\n', onChange }
		});
		flushSync();
		try {
			// A real CodeMirror transaction against the mounted view, the same
			// way a keystroke would arrive — exercises the updateListener at
			// MetamodelYamlEditor.svelte's primary write path end to end.
			const view = findView();
			view.dispatch({ changes: { from: 0, to: 0, insert: '# comment\n' } });
			flushSync();
			expect(onChange).toHaveBeenCalledTimes(1);
			expect(onChange).toHaveBeenCalledWith('# comment\nelements: []\n');
		} finally {
			unmount(c);
		}
	});

	it('an external code replacement updates the document without echoing through onChange', () => {
		// MetamodelYamlEditor's updateListener must not fire for the
		// transaction the component itself dispatches to apply an external
		// `code` prop replacement (baseline load / draft restore / discard),
		// or setting `code` from outside would immediately call `onChange`
		// back with that same value, as if the user had typed it. The
		// component tags that transaction and the listener skips it.
		const onChange = vi.fn();
		const c = mount(MetamodelYamlEditorHost, { target: document.body, props: { onChange } });
		flushSync();
		try {
			const host = c as unknown as { setCode: (code: string) => void };
			host.setCode('elements:\n  - foo\n');
			flushSync();
			const el = document.querySelector('[data-testid="metamodel-editor"]');
			expect(el!.textContent).toContain('foo');
			expect(onChange).not.toHaveBeenCalled();
		} finally {
			unmount(c);
		}
	});

	it('readOnly blocks user edits at the CodeMirror level', () => {
		const onChange = vi.fn();
		const c = mount(MetamodelYamlEditor, {
			target: document.body,
			props: { code: 'elements: []\n', onChange, readOnly: true }
		});
		flushSync();
		try {
			const cmContent = document.querySelector('.cm-content');
			expect(cmContent?.getAttribute('contenteditable')).toBe('false');
		} finally {
			unmount(c);
		}
	});

	it('only positioned errors (non-null line) become lint gutter diagnostics', () => {
		const onChange = vi.fn();
		const errors: MetamodelLintError[] = [
			{ message: 'positioned problem', line: 2, column: 3 },
			{ message: 'file-level problem', line: null, column: null }
		];
		const c = mount(MetamodelYamlEditor, {
			target: document.body,
			props: { code: 'elements:\n  - foo\n', onChange, errors }
		});
		flushSync();
		try {
			const view = findView();
			expect(diagnosticCount(view.state)).toBe(1);
			const messages: string[] = [];
			forEachDiagnostic(view.state, (d) => messages.push(d.message));
			expect(messages).toEqual(['positioned problem']);
		} finally {
			unmount(c);
		}
	});
});
