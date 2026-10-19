// Pattern matching, compiled from the published declarations (exhaustiveness, narrowing and captures are tested in
// src/functions/functions.spec.ts: this only proves the declarations work for a consumer, cheaply).
import { active, captureAs, matchWith } from 'tinkit/functions';

type Event = { type: 'click'; x: number } | { type: 'key'; key: string } | { type: 'close' };
declare const event: Event;

const label: number | string = matchWith(event)
	.with({ type: 'click', x: captureAs('x') }, function ({ x }) {
		return x;
	})
	.with({ type: 'key' }, function (key) {
		return key.key;
	})
	.with({ type: 'close' }, function () {
		return 'closed';
	})
	.exhaustive();

declare function toInteger(text: string): number | undefined;
declare const input: string | number;

// @ts-expect-error the function of an active pattern must accept every value at its position
matchWith(input).with(active(toInteger), String);
// @ts-expect-error an `any` value needs `otherwise` (or a final `_` case)
matchWith(JSON.parse('1')).with(1, String).exhaustive();

export { label };
