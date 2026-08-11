import { flushSync, mount, unmount } from 'svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';

import MetamodelYamlEditor from '../MetamodelYamlEditor.svelte';

afterEach(() => {
	document.body.innerHTML = '';
});

describe('MetamodelYamlEditor', () => {
	it('renders the document and reports edits via onChange', () => {
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
});
