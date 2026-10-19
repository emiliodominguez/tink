import { createHistory, createMachine, createStore } from 'tinkit/store';
import type { HistoryState, Machine, MachineSnapshot, StateConfig, StoreHistory } from 'tinkit/store';
import { darken, inGamut, lighten, mix, oklabToRgb, oklchToRgb, parseColor, toCssOklch, toOklab, toOklch } from 'tinkit/color';
import type { HueInterpolation, MixSpace, Oklab, Oklch, OklchInput, Rgba } from 'tinkit/color';

const fetcher = createMachine({
	initial: 'idle',
	context: { data: '', retries: 0 },
	states: {
		idle: { on: { FETCH: 'loading' } },
		loading: {
			on: {
				RESOLVE: {
					target: 'done',
					update(context, event: { type: 'RESOLVE'; data: string }) {
						return { ...context, data: event.data };
					}
				},
				REJECT: {
					target: 'idle',
					guard(context) {
						return context.retries < 3;
					},
					update(context) {
						return { ...context, retries: context.retries + 1 };
					}
				}
			}
		},
		done: {}
	}
});
fetcher.send('FETCH');
fetcher.send({ type: 'RESOLVE', data: 'hello' });
const fetched: boolean = fetcher.can('REJECT') && fetcher.matches('loading');
const machineSnapshot: MachineSnapshot<'idle' | 'loading' | 'done', { data: string; retries: number }> = fetcher.getState();
const asMachine: Machine<'idle' | 'loading' | 'done', { data: string; retries: number }, { type: 'FETCH' } | { type: 'REJECT' } | { type: 'RESOLVE'; data: string }> = fetcher;
// @ts-expect-error RESOLVE requires its payload
fetcher.send('RESOLVE');
// @ts-expect-error no state handles this event
fetcher.send({ type: 'CANCEL' });
// @ts-expect-error not a state of the machine
fetcher.matches('error');
// @ts-expect-error unknown transition target
createMachine({ initial: 'a', states: { a: { on: { GO: 'b' } } } });
// @ts-expect-error unknown initial state
createMachine({ initial: 'z', states: { a: {} } });

// An event handled by several states needs every payload they declare.
const editorMachine = createMachine({
	initial: 'editing',
	context: '',
	states: {
		editing: {
			on: {
				SAVE: {
					target: 'saved',
					update(text, event: { type: 'SAVE'; text: string }) {
						return text + event.text;
					}
				}
			}
		},
		saved: { on: { SAVE: 'editing' } }
	}
});
editorMachine.send({ type: 'SAVE', text: 'x' });
// @ts-expect-error the editing state requires the text
editorMachine.send('SAVE');
// @ts-expect-error the editing state requires the text
editorMachine.send({ type: 'SAVE' });
createMachine({
	initial: 'a',
	context: '',
	states: {
		a: {
			on: {
				// @ts-expect-error the event parameter is annotated with another event type
				RESOLVE: {
					update(context: string, event: { type: 'REJECT'; data: string }): string {
						return context + event.data;
					}
				}
			}
		}
	}
});
// Configs declared apart from the call keep their literal types with `as const` (and `satisfies` for typed guards and updates).
const counterStates = {
	idle: {
		on: {
			ADD: {
				update(count: number, event: { type: 'ADD'; by: number }): number {
					return count + event.by;
				}
			}
		}
	}
} as const satisfies Record<string, StateConfig<number>>;
const counter = createMachine({ initial: 'idle', context: 0, states: counterStates });
counter.send({ type: 'ADD', by: 1 });
// @ts-expect-error ADD requires `by`
counter.send('ADD');

const editor = createStore({ text: '' });
const history: StoreHistory = createHistory(editor, {
	limit: 100,
	coalesce: 300,
	now(): number {
		return 0;
	}
});
createHistory(editor, {
	// @ts-expect-error the clock returns milliseconds
	now(): string {
		return '0';
	}
});
const historyState: HistoryState = history.getState();
const undone: boolean = history.undo() || history.redo();
const batched: number = history.batch(function () {
	editor.setState({ text: 'a' });
	return 1;
});
// @ts-expect-error a machine is read-only: it has no setState
createHistory(fetcher);

const lch: Required<Oklch> = toOklch('#ff8000');
const lab: Required<Oklab> = toOklab('oklch(0.7 0.15 50)');
const back: Rgba = oklchToRgb({ l: 0.7, c: 0.4, h: 145 });
const fromJson: OklchInput = { l: 0.5, c: 0, h: null };
const powerless: Rgba = oklchToRgb(fromJson) && oklchToRgb({ l: 0.5, c: 0 });
const lchHue: number = lch.h;
const fromLab: Rgba = oklabToRgb({ l: 0.5, a: 0.1, b: -0.1, alpha: 0.5 });
const css: string = toCssOklch(parseColor('#bada55'));
const displayable: boolean = inGamut({ l: 0.7, c: 0.3, h: 145 });
const space: MixSpace = 'oklch';
const hue: HueInterpolation = 'longer';
const mixed: Rgba = mix('#00f', '#ff0', 0.5, { space, hue });
const lighter: Rgba = lighten('#336699', 10, { space: 'oklch' });
const darker: Rgba = darken('#336699', 10, { space: 'hsl' });
// @ts-expect-error unknown mix space
mix('#000', '#fff', 0.5, { space: 'lab' });
// @ts-expect-error oklab is not a lightness space
lighten('#000', 10, { space: 'oklab' });
// @ts-expect-error Oklch objects need a chroma
oklchToRgb({ l: 0.5, h: 0 });
void [fetched, machineSnapshot, asMachine, historyState, undone, batched, lch, lab, back, powerless, lchHue, fromLab, css, displayable, mixed, lighter, darker];
