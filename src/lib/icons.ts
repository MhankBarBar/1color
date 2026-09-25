// Inline icon set: 24px stroke icons matching the app's control row.
//
// Every icon carries explicit width/height as well as a viewBox: a viewBox alone
// gives an SVG no intrinsic size, and WebKit resolves `max-width: 100%` on such an
// element to zero, collapsing it — which made Save, Share, and Compare render as
// empty circles on iOS Safari and Chrome.
const ICON_PX = 24;

const S = (body: string, extra = ''): string =>
	`<svg width="${ICON_PX}" height="${ICON_PX}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" ${extra} aria-hidden="true">${body}</svg>`;

export const icons = {
	accent: S(
		'<circle cx="12" cy="12" r="9"/><path d="M12 3a9 9 0 0 0 0 18Z" fill="currentColor" stroke="none"/>'
	),
	range: S(
		'<circle cx="12" cy="12" r="3.2"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3"/><circle cx="12" cy="12" r="7.5"/>'
	),
	mono: S(
		'<circle cx="12" cy="12" r="9"/><path d="M12 3a9 9 0 0 1 0 18Z" fill="currentColor" stroke="none"/><path d="M12 3v18"/>'
	),
	output: S('<rect x="3.5" y="3.5" width="17" height="17" rx="3"/><path d="M3.5 9h17M9 20.5v-11"/>'),
	photo: S('<rect x="3" y="4.5" width="18" height="15" rx="3"/><circle cx="8.5" cy="10" r="1.6"/><path d="m3.8 17 4.6-4.3 3.4 3.1 3.2-3 5.2 4.9"/>'),
	upload: S('<path d="M12 16V4m0 0L7.5 8.5M12 4l4.5 4.5"/><path d="M4 15v3.5A1.5 1.5 0 0 0 5.5 20h13a1.5 1.5 0 0 0 1.5-1.5V15"/>'),
	share: S('<path d="M12 15V3m0 0L8 7m4-4 4 4"/><path d="M4.5 13.5V19a2 2 0 0 0 2 2h11a2 2 0 0 0 2-2v-5.5"/>'),
	save: S('<path d="M4.5 14.5V19a2 2 0 0 0 2 2h11a2 2 0 0 0 2-2v-4.5"/><path d="M12 3v11m0 0-4-4m4 4 4-4"/>'),
	circle: S('<circle cx="12" cy="12" r="8.5"/>'),
	square: S('<rect x="4" y="4" width="16" height="16" rx="2.5"/>'),
	lasso: S('<path d="M12 4.5c4.7 0 8.5 2.9 8.5 6.5s-3.8 6.5-8.5 6.5c-1.6 0-3-.3-4.3-.8"/><path d="M7.7 16.7C5.4 15.7 3.5 13.9 3.5 11c0-3.6 3.8-6.5 8.5-6.5"/><path d="M8.2 16.9c-.5 1-.3 2.2.5 3"/>'),
	brush: S('<path d="M15.5 4.5 20 9l-8.5 8.5H7v-4.4Z"/><path d="M4 20.5c1.6-.4 2.4-1.3 2.8-2.6"/>'),
	hand: S('<path d="M9 11V5.8a1.6 1.6 0 0 1 3.2 0V11"/><path d="M12.2 10.4V4.6a1.6 1.6 0 0 1 3.2 0v6.6"/><path d="M15.4 11.6V7.4a1.6 1.6 0 0 1 3.2 0V15a6 6 0 0 1-6 6h-1a6 6 0 0 1-6-6v-2.4a1.6 1.6 0 0 1 3.2 0"/>'),
	rotate: S('<path d="M20 12a8 8 0 1 1-2.6-5.9"/><path d="M20 3.5V8h-4.5"/>'),
	camera: S('<path d="M4 8.5h2.6l1.4-2.3h8l1.4 2.3H20a1.5 1.5 0 0 1 1.5 1.5v7.5A1.5 1.5 0 0 1 20 19H4a1.5 1.5 0 0 1-1.5-1.5V10A1.5 1.5 0 0 1 4 8.5Z"/><circle cx="12" cy="13.5" r="3.4"/>'),
	info: S('<circle cx="12" cy="12" r="9"/><path d="M12 11v5.5M12 7.8v.4"/>'),
	reset: S('<path d="M4 12a8 8 0 1 0 2.6-5.9"/><path d="M4 3.5V8h4.5"/>'),
	chevron: S('<path d="m9 6 6 6-6 6"/>'),
	chevronDown: S('<path d="m6 9 6 6 6-6"/>'),
	compare: S('<rect x="3" y="4.5" width="18" height="15" rx="3"/><path d="M12 3v18"/><path d="M7 12h3M14 12h3"/>', 'stroke-width="1.6"'),
	spark: S('<path d="M12 3.5v4M12 16.5v4M3.5 12h4M16.5 12h4M6 6l2.8 2.8M15.2 15.2 18 18M18 6l-2.8 2.8M8.8 15.2 6 18"/>')
};

/** Every icon this app draws, by name. */
export type IconName = keyof typeof icons;

/** Returns raw SVG markup for {@html}. */
export const icon = (name: IconName): string => icons[name] || icons.accent;
