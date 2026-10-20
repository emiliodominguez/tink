// Tokenizer and BM25 index, compiled from the published declarations (behaviour is tested in src/search: this only proves the
// declarations work for a consumer).
import { createSearchIndex, tokenize } from 'tinkit/search';
import type { SearchId, SearchIndex, SearchIndexOptions, SearchIndexQueryOptions, SearchIndexResult, TokenizeOptions, WordSegmenter } from 'tinkit/search';

interface Article {
	id: number;
	title: string;
	tags: string[];
}

declare const segmenter: WordSegmenter;
const words: string[] = tokenize('Hello, World', { ignoreDiacritics: true, minLength: 2, stopWords: new Set(['the']) });
const tokenizeOptions: TokenizeOptions = { segmenter, caseSensitive: true };
tokenize('東京', tokenizeOptions);
// @ts-expect-error stop words are a Set
tokenize('a', { stopWords: ['the'] });

const options: SearchIndexOptions<Article> = {
	fields: { title: 2, tags: 1 },
	tokenize: function (text) {
		return tokenize(text, { ignoreDiacritics: true });
	},
	k1: 1.5,
	b: 0.5
};
const index: SearchIndex<Article> = createSearchIndex(options);
createSearchIndex<Article>({ fields: ['title', 'tags'], id: 'id' });
createSearchIndex<Article>({
	fields: ['tags'],
	extract: function (article, field) {
		return field === 'tags' ? article.tags : null;
	}
});
// @ts-expect-error fields are required
createSearchIndex<Article>({ id: 'id' });
// @ts-expect-error boosts are numbers
createSearchIndex<Article>({ fields: { title: 'high' } });
createSearchIndex<Article>({
	fields: ['title'],
	// @ts-expect-error the tokenizer returns strings
	tokenize: function (text: string) {
		return text.length;
	}
});

index.add({ id: 1, title: 'Hello', tags: ['greeting'] });
index.addAll([{ id: 2, title: 'World', tags: [] }]);
const replaced: boolean = index.replace({ id: 2, title: 'Earth', tags: [] });
const removed: boolean = index.remove(1);
const present: boolean = index.has('1');
const found: Article | undefined = index.get(2);
const size: number = index.size;
// @ts-expect-error size is read-only
index.size = 3;
// @ts-expect-error documents have the index's type
index.add({ id: 3 });

const query: SearchIndexQueryOptions<Article> = {
	limit: 10,
	prefix: 'last',
	combine: 'and',
	filter: function (article) {
		return article.tags.length > 0;
	}
};
const results: Array<SearchIndexResult<Article>> = index.search('hel', query);
const first: SearchIndexResult<Article> | undefined = results[0];
const id: SearchId | undefined = first?.id;
const title: string | undefined = first?.item.title;
const terms: string[] | undefined = first?.terms;
// @ts-expect-error prefix is a boolean or 'last'
index.search('a', { prefix: 'first' });
// @ts-expect-error combine is 'or' or 'and'
index.search('a', { combine: 'xor' });

void [words, replaced, removed, present, found, size, id, title, terms];
