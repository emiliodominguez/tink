import { bufferTime, interleave, mergeAsync, pairwise, parseNdjson, parseSSE, partition, readLines, streamToArray, streamToBytes, streamToText } from 'tinkit/iterables';
import type {
	BufferTimeOptions,
	MergedValue,
	ParseNdjsonOptions,
	ParseSSEOptions,
	ReadableStreamLike,
	ReadableStreamReaderLike,
	ReadLinesOptions,
	ServerSentEvent,
	StreamReadOptions,
	StreamSource,
	StreamToArrayOptions,
	StreamToBytesOptions,
	StreamToTextOptions,
	TextStreamSource
} from 'tinkit/iterables';

// A stream as a consumer without the DOM type library would describe it.
declare const byteReader: ReadableStreamReaderLike<Uint8Array>;
const byteStream: ReadableStreamLike<Uint8Array> = {
	getReader(): ReadableStreamReaderLike<Uint8Array> {
		return byteReader;
	}
};
declare const textChunks: AsyncIterable<string>;
declare const mixedChunks: Array<string | Uint8Array | Promise<string>>;

const sources: TextStreamSource[] = [byteStream, textChunks, mixedChunks, 'whole text', new Uint8Array(2)];
const signalOptions: StreamReadOptions = { signal: null };
const lineOptions: ReadLinesOptions = { maxLineLength: 1024, signal: undefined };
const lines: AsyncIterableIterator<string> = readLines(byteStream, lineOptions);
// @ts-expect-error numbers are not text chunks
readLines([1, 2]);
// @ts-expect-error `maxLineLength` is a number
readLines('', { maxLineLength: '5' });

const sseOptions: ParseSSEOptions = {
	maxLineLength: 1 << 20,
	maxDataLength: 1 << 24,
	onRetry: function (milliseconds: number): void {
		void milliseconds;
	}
};
const events: AsyncIterableIterator<ServerSentEvent> = parseSSE(textChunks, sseOptions);
async function readEvents(): Promise<void> {
	for await (const { event, data, id, retry } of events) {
		const fields: [string, string, string, number | undefined] = [event, data, id, retry];
		void fields;
	}
}
// @ts-expect-error `onRetry` takes milliseconds
parseSSE('', { onRetry: function (_ms: string): void {} });
// @ts-expect-error `maxDataLength` is a number
parseSSE('', { maxDataLength: '5' });

const ndjsonOptions: ParseNdjsonOptions = {
	reviver: function (key: string, value: unknown): unknown {
		return key === 'date' ? String(value) : value;
	}
};
const values: AsyncIterableIterator<unknown> = parseNdjson(mixedChunks, ndjsonOptions);
const records: AsyncIterableIterator<{ id: number }> = parseNdjson<{ id: number }>(byteStream);

const textOptions: StreamToTextOptions = { maxLength: 10 };
const bytesOptions: StreamToBytesOptions = { maxBytes: 10 };
const arrayOptions: StreamToArrayOptions = { maxLength: 10 };
const text: Promise<string> = streamToText(byteStream, textOptions);
const bytes: Promise<Uint8Array<ArrayBuffer>> = streamToBytes(byteStream, bytesOptions);
// @ts-expect-error streamToBytes reads Uint8Array chunks only
streamToBytes(textChunks);
// @ts-expect-error streamToText has no `maxBytes`
streamToText(byteStream, { maxBytes: 1 });
const chunks: Promise<string[]> = streamToArray(textChunks, arrayOptions);
const numbers: Promise<number[]> = streamToArray([1, Promise.resolve(2)]);
// The chunk type is inferred from an async iterable; a stream that is not async iterable takes it explicitly.
declare const numberStream: ReadableStreamLike<number>;
const explicit: Promise<number[]> = streamToArray<number>(numberStream);
const source: StreamSource<number> = numberStream;

declare const ticks: AsyncGenerator<number>;
const merged: AsyncIterableIterator<number | string> = mergeAsync(ticks, ['a', Promise.resolve('b')]);
const mergedType: MergedValue<[AsyncIterable<number>, Array<Promise<boolean>>]> = true;
// @ts-expect-error a string is not one of the merged types
const wrongMerged: MergedValue<[AsyncIterable<number>]> = 'x';

const batchOptions: BufferTimeOptions = { maxSize: 100, signal: null };
const batches: AsyncIterableIterator<number[]> = bufferTime(ticks, 50, batchOptions);
// @ts-expect-error `ms` is a number
bufferTime(ticks, '50');

const interleaved: IterableIterator<number | string | boolean> = interleave([1, 2], 'ab', new Set([true]));
const pairs: IterableIterator<[number, number]> = pairwise([1, 2, 3]);
const [evens, odds]: [number[], number[]] = partition(new Set([1, 2, 3]), function (n: number): boolean {
	return n % 2 === 0;
});
const [strings, rest]: [string[], number[]] = partition([1, 'a'] as Array<number | string>, function (value): value is string {
	return typeof value === 'string';
});

void [sources, signalOptions, lines, readEvents, values, records, text, bytes, chunks, numbers, explicit, source, merged, mergedType, wrongMerged];
void [batches, interleaved, pairs, evens, odds, strings, rest];
