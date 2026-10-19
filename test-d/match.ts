// Pattern matching, compiled from the published declarations (exhaustiveness, narrowing and captures are tested in
// src/functions/functions.spec.ts: this only proves the declarations work for a consumer, cheaply).
import { captureAs, matchWith } from 'tinkit/functions';

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

export { label };
