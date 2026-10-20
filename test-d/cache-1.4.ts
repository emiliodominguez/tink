import { createBiMap, createBloomFilter, createDefaultMap, createMultiMap, createRingBuffer, createTrie } from 'tinkit/cache';
import type { BiMap, BloomFilter, BloomFilterOptions, DefaultMap, MultiMap, MultiMapOptions, RingBuffer, RingBufferOptions, Trie, TrieQueryOptions } from 'tinkit/cache';

const ringOptions: RingBufferOptions<number> = {
	onEvict(value) {
		const evicted: number = value;
		void evicted;
	}
};
const ring: RingBuffer<number> = createRingBuffer(3, ringOptions);
const pushed: number = ring.push(1);
const oldest: number | undefined = ring.peekFirst();
const values: number[] = ring.toArray();
const full: boolean = ring.full;
// @ts-expect-error the buffer holds numbers
ring.push('x');
// @ts-expect-error `full` is read-only
ring.full = true;

const groups: DefaultMap<string, string[]> = createDefaultMap(function (): string[] {
	return [];
});
const group: string[] = groups.get('a');
const peeked: string[] | undefined = groups.peek('a');
// @ts-expect-error the factory must return the value type
createDefaultMap<string, number>(function (): string {
	return '';
});

const codes: BiMap<string, number> = createBiMap([['a', 1]]);
const code: number | undefined = codes.get('a');
const key: string | undefined = codes.getKey(1);
const inverse: BiMap<number, string> = codes.inverse;
// @ts-expect-error values are numbers
codes.getKey('a');
// @ts-expect-error the inverse is fixed
codes.inverse = inverse;

const multiOptions: MultiMapOptions = { unique: true };
const tags: MultiMap<string, number> = createMultiMap<string, number>(null, multiOptions);
const added: boolean = tags.add('a', 1);
const tagged: number[] = tags.get('a');
const removedAll: boolean = tags.delete('a');
const removedOne: boolean = tags.delete('a', 1);
const keyCount: number = tags.keyCount;
// @ts-expect-error one value at most
tags.delete('a', 1, 2);

const queryOptions: TrieQueryOptions = { limit: 5 };
const words: Trie<number> = createTrie([['car', 1]]);
const completions: string[] = words.keysWithPrefix('ca', queryOptions);
const pairs: Array<[string, number]> = words.entriesWithPrefix('ca');
const longest: string | undefined = words.longestPrefixOf('carton');
// @ts-expect-error keys are strings
words.set(1, 1);

const sized: BloomFilterOptions = { expectedItems: 1000, falsePositiveRate: 0.01 };
const filter: BloomFilter = createBloomFilter(sized);
const restored: BloomFilter = createBloomFilter({ bits: filter.bits, hashes: filter.hashes, data: filter.toBytes() });
const fresh: boolean = restored.add('x');
const rate: number = restored.estimatedFalsePositiveRate();
// @ts-expect-error the two forms of options do not mix
createBloomFilter({ expectedItems: 10, bits: 64, hashes: 2 });
// @ts-expect-error items are strings
filter.has(1);

void [pushed, oldest, values, full, group, peeked, code, key, added, tagged, removedAll, removedOne, keyCount, completions, pairs, longest, fresh, rate];
