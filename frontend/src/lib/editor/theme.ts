// Dark editor theme for the Python snippet editor.
//
// CodeMirror's `basicSetup` ships the default *light* theme, which is the root
// cause of the editor looking foreign to the app: a white gutter, white-on-
// white lint tooltips, a selection that washes out text, and harsh purple
// keywords. This module replaces that with a dark treatment cohesive with the
// app's "modern luxury" sage-green identity.
//
// Surface colours reference the app's own design tokens (var(--card),
// var(--border), var(--destructive), …) so the editor tracks the global
// palette. Syntax-token colours come from the dedicated --cm-* variables
// defined in app.css. Keep the two in sync.
import { EditorView } from '@codemirror/view';
import { HighlightStyle, syntaxHighlighting } from '@codemirror/language';
import { tags as t } from '@lezer/highlight';

const MONO =
	"ui-monospace, SFMono-Regular, 'SF Mono', Menlo, Consolas, 'Liberation Mono', 'Courier New', monospace";

// Editor chrome: surfaces, gutter, cursor, selection, active line, lint UI.
const editorTheme = EditorView.theme(
	{
		'&': {
			color: 'var(--cm-plain)',
			backgroundColor: 'var(--card)',
			fontSize: '0.8125rem',
			height: '100%'
		},
		'.cm-content': {
			fontFamily: MONO,
			caretColor: 'var(--primary)',
			padding: '0.5rem 0'
		},
		'.cm-scroller': {
			fontFamily: MONO,
			lineHeight: '1.6'
		},
		// Placeholder ghost text — muted so it reads as a hint, not content.
		'.cm-placeholder': {
			color: 'var(--muted-foreground)',
			opacity: '0.7'
		},
		'&.cm-focused': { outline: 'none' },

		// Cursor.
		'.cm-cursor, .cm-dropCursor': {
			borderLeftColor: 'var(--primary)',
			borderLeftWidth: '2px'
		},

		// Selection — a translucent green tint drawn *behind* the glyphs (via
		// drawSelection from basicSetup), so token colours stay fully legible.
		'.cm-selectionBackground, .cm-content ::selection': {
			backgroundColor: 'var(--cm-selection)'
		},
		'&.cm-focused .cm-selectionBackground, &.cm-focused .cm-content ::selection': {
			backgroundColor: 'var(--cm-selection)'
		},
		'.cm-selectionMatch': {
			backgroundColor: 'var(--cm-selection)',
			borderRadius: '2px'
		},

		// Active line + its gutter marker. The line-numbers gutter marker carries
		// a thin primary-green spine — the editor's one signature accent.
		'.cm-activeLine': { backgroundColor: 'var(--cm-active-line)' },
		'.cm-activeLineGutter': {
			backgroundColor: 'var(--cm-active-line)',
			color: 'var(--cm-gutter-active-fg)'
		},
		// Draw the spine ONLY on the line-numbers gutter. `.cm-activeLineGutter`
		// matches the active row in every gutter (line numbers, fold, lint), so an
		// unscoped spine painted a second/third bar to the right of the number.
		'.cm-lineNumbers .cm-activeLineGutter': {
			boxShadow: 'inset 2px 0 0 var(--primary)'
		},

		// Gutter — was a jarring white block; now blends with the card surface.
		'.cm-gutters': {
			backgroundColor: 'var(--card)',
			color: 'var(--cm-gutter-fg)',
			border: 'none',
			borderRight: '1px solid var(--border)'
		},
		'.cm-lineNumbers .cm-gutterElement': {
			padding: '0 0.65rem 0 1rem',
			minWidth: '2.5ch'
		},
		'.cm-foldGutter .cm-gutterElement': { color: 'var(--cm-gutter-fg)' },

		// Bracket matching.
		'.cm-matchingBracket': {
			backgroundColor: 'oklch(0.78 0.06 155 / 22%)',
			color: 'var(--cm-plain)',
			outline: '1px solid oklch(0.78 0.06 155 / 45%)',
			borderRadius: '2px'
		},
		'.cm-nonmatchingBracket': {
			backgroundColor: 'oklch(0.66 0.14 25 / 22%)'
		},

		// Autocomplete + generic tooltips.
		'.cm-tooltip': {
			backgroundColor: 'var(--popover)',
			color: 'var(--popover-foreground)',
			border: '1px solid var(--border)',
			borderRadius: 'var(--radius-md)',
			boxShadow: '0 8px 28px -12px rgb(0 0 0 / 55%)'
		},
		'.cm-tooltip.cm-tooltip-autocomplete > ul > li[aria-selected]': {
			backgroundColor: 'var(--accent)',
			color: 'var(--accent-foreground)'
		},

		// Lint UI — squiggle underlines are tinted per severity (bottom-positioned wavy
		// SVGs so the glyph itself is untouched); the hover panel uses the
		// popover surface with a coloured spine.
		'.cm-lintRange-error': { backgroundImage: wavyUnderline('#e5646a') },
		'.cm-lintRange-warning': { backgroundImage: wavyUnderline('#e0b64f') },
		'.cm-lintRange-info': { backgroundImage: wavyUnderline('#7fb0d8') },
		'.cm-tooltip-lint': {
			padding: '0'
		},
		'.cm-diagnostic': {
			padding: '0.375rem 0.6rem',
			fontFamily: MONO,
			fontSize: '0.75rem',
			color: 'var(--popover-foreground)',
			borderLeft: '3px solid transparent'
		},
		'.cm-diagnostic-error': { borderLeftColor: 'var(--destructive)' },
		'.cm-diagnostic-warning': { borderLeftColor: 'var(--warning)' },
		'.cm-diagnostic-info': { borderLeftColor: 'var(--info)' },

		// Lint gutter markers.
		'.cm-lint-marker-error': { color: 'var(--destructive)' },
		'.cm-lint-marker-warning': { color: 'var(--warning)' },
		'.cm-lint-marker-info': { color: 'var(--info)' },

		// Search panel. `basicSetup` gives only `searchKeymap`; the panel itself
		// comes from `search-panel.ts` (a custom `createPanel`), which builds
		// plain DOM with the class names below. Everything here is presentation
		// for that markup — behaviour lives in @codemirror/search.
		'.cm-panels': {
			backgroundColor: 'var(--popover)',
			color: 'var(--popover-foreground)',
			border: 'none'
		},
		'.cm-panels-top': { borderBottom: '1px solid var(--border)' },
		'.cm-panels-bottom': { borderTop: '1px solid var(--border)' },

		'.cm-dr-search': {
			display: 'flex',
			flexDirection: 'column',
			gap: '0.3rem',
			padding: '0.45rem 0.6rem',
			fontFamily: 'inherit',
			fontSize: '0.75rem'
		},
		'.cm-dr-search-row': {
			display: 'flex',
			alignItems: 'center',
			gap: '0.35rem'
		},
		'.cm-dr-search-field': {
			flex: '1',
			minWidth: '0',
			backgroundColor: 'var(--card)',
			color: 'var(--foreground)',
			border: '1px solid var(--border)',
			borderRadius: 'var(--radius-md)',
			padding: '0.2rem 0.5rem',
			fontFamily: MONO,
			fontSize: '0.75rem',
			outline: 'none'
		},
		'.cm-dr-search-field:focus': {
			borderColor: 'var(--primary)',
			boxShadow: '0 0 0 2px oklch(0.78 0.06 155 / 18%)'
		},
		'.cm-dr-search-invalid': {
			borderColor: 'var(--destructive)',
			boxShadow: '0 0 0 2px oklch(0.66 0.14 25 / 18%)'
		},
		'.cm-dr-search-count': {
			flexShrink: '0',
			minWidth: '4.5ch',
			textAlign: 'right',
			color: 'var(--muted-foreground)',
			fontFamily: MONO,
			fontSize: '0.6875rem',
			fontVariantNumeric: 'tabular-nums'
		},
		'.cm-dr-search-btn': {
			display: 'inline-flex',
			alignItems: 'center',
			justifyContent: 'center',
			flexShrink: '0',
			width: '1.5rem',
			height: '1.5rem',
			padding: '0',
			border: 'none',
			borderRadius: 'var(--radius-md)',
			background: 'transparent',
			color: 'var(--muted-foreground)',
			cursor: 'pointer',
			transition: 'background-color 120ms ease, color 120ms ease'
		},
		'.cm-dr-search-btn:hover': {
			backgroundColor: 'var(--accent)',
			color: 'var(--accent-foreground)'
		},
		'.cm-dr-search-btn svg': { width: '0.875rem', height: '0.875rem' },
		'.cm-dr-search-chips': {
			display: 'flex',
			alignItems: 'center',
			gap: '0.3rem',
			paddingLeft: '1.85rem'
		},
		'.cm-dr-search-chip': {
			padding: '0.1rem 0.4rem',
			border: '1px solid var(--border)',
			borderRadius: '999px',
			background: 'transparent',
			color: 'var(--muted-foreground)',
			fontFamily: MONO,
			fontSize: '0.6875rem',
			lineHeight: '1.2',
			cursor: 'pointer',
			transition: 'background-color 120ms ease, color 120ms ease, border-color 120ms ease'
		},
		'.cm-dr-search-chip:hover': { color: 'var(--foreground)' },
		'.cm-dr-search-chip[aria-pressed="true"]': {
			backgroundColor: 'oklch(0.78 0.06 155 / 18%)',
			borderColor: 'oklch(0.78 0.06 155 / 45%)',
			color: 'var(--cm-plain)'
		},
		'.cm-dr-search-replace': { paddingLeft: '1.85rem' },
		'.cm-dr-search-action': {
			flexShrink: '0',
			padding: '0.2rem 0.5rem',
			border: '1px solid var(--border)',
			borderRadius: 'var(--radius-md)',
			background: 'transparent',
			color: 'var(--foreground)',
			fontSize: '0.6875rem',
			cursor: 'pointer',
			transition: 'background-color 120ms ease'
		},
		'.cm-dr-search-action:hover': { backgroundColor: 'var(--accent)' }
	},
	{ dark: true }
);

// Bottom-positioned wavy underline as an inline SVG data URI, tinted per lint
// severity. CodeMirror's base lint theme sets `.cm-lintRange` to repeat this
// image at `left bottom`, so it draws a squiggle under the glyphs without
// touching their colour. A concrete colour (not a CSS var) is required — var()
// cannot live inside a data URI — so severity colours are passed as hex.
function wavyUnderline(color: string): string {
	const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="6" height="3"><path d="m0 3 l2 -2 l1 0 l2 2 l1 0" stroke="${color}" fill="none" stroke-width=".8"/></svg>`;
	return `url('data:image/svg+xml,${encodeURIComponent(svg)}')`;
}

// Syntax highlighting — earthy-jewel palette anchored in the app's green.
const highlightStyle = HighlightStyle.define([
	{
		tag: [t.comment, t.lineComment, t.blockComment, t.docComment],
		color: 'var(--cm-comment)',
		fontStyle: 'italic'
	},

	{
		tag: [t.keyword, t.moduleKeyword, t.controlKeyword, t.operatorKeyword, t.definitionKeyword],
		color: 'var(--cm-keyword)',
		fontWeight: '500'
	},
	{ tag: [t.self, t.null, t.atom, t.bool], color: 'var(--cm-number)' },

	{ tag: [t.string, t.special(t.string), t.regexp, t.docString], color: 'var(--cm-string)' },
	{ tag: [t.number, t.integer, t.float], color: 'var(--cm-number)' },
	{ tag: t.escape, color: 'var(--cm-accent)' },

	{
		tag: [t.function(t.variableName), t.function(t.definition(t.variableName))],
		color: 'var(--cm-function)'
	},
	{ tag: [t.definition(t.variableName), t.variableName], color: 'var(--cm-plain)' },
	{ tag: [t.propertyName, t.function(t.propertyName)], color: 'var(--cm-property)' },

	{
		tag: [t.typeName, t.className, t.namespace, t.standard(t.variableName)],
		color: 'var(--cm-type)'
	},
	{ tag: [t.meta, t.annotation], color: 'var(--cm-accent)' },

	{
		tag: [
			t.operator,
			t.arithmeticOperator,
			t.logicOperator,
			t.compareOperator,
			t.definitionOperator
		],
		color: 'var(--cm-operator)'
	},
	{
		tag: [t.punctuation, t.paren, t.brace, t.squareBracket, t.bracket, t.separator],
		color: 'var(--cm-punctuation)'
	},

	{ tag: [t.strong], fontWeight: '600' },
	{ tag: [t.emphasis], fontStyle: 'italic' },
	{ tag: t.invalid, color: 'var(--destructive)', textDecoration: 'underline wavy' }
]);

/** The editor theme + syntax highlighting, added after `basicSetup` so this
 * highlight style takes precedence over CodeMirror's default light one. */
export const editorLuxuryTheme = [editorTheme, syntaxHighlighting(highlightStyle)];
