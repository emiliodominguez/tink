/**
 * PRIVATE Latin folding tables shared by the strings module (`removeDiacritics`, `toSlug`) and the search module (`ignoreDiacritics`), so
 * that search folds letters exactly the way `toSlug` does. Not part of the public API: this file is not re-exported by `utils/index.ts`
 * or the package root, and the `exports` map does not reach it.
 * @internal
 * @packageDocumentation
 */

/** Any non-ASCII code unit. */
export const NON_ASCII = /[^\0-\x7f]/;

/**
 * The combining diacritical mark blocks (U+0300–036F, U+1AB0–1AFF, U+1DC0–1DFF, U+20D0–20FF, U+FE20–FE2F). Global: only use it with
 * `replace`, which resets its `lastIndex`.
 */
export const DIACRITICS = /[̀-ͯ᪰-᫿᷀-᷿⃐-⃿︠-︯]/g;

/** Latin letters without a Unicode decomposition, mapped to their usual ASCII transliteration. */
const TRANSLITERATIONS: Readonly<Record<string, string>> = {
	ß: 'ss',
	ẞ: 'SS',
	æ: 'ae',
	Æ: 'AE',
	œ: 'oe',
	Œ: 'OE',
	ø: 'o',
	Ø: 'O',
	đ: 'd',
	Đ: 'D',
	ð: 'd',
	Ð: 'D',
	ł: 'l',
	Ł: 'L',
	þ: 'th',
	Þ: 'TH',
	ı: 'i'
};

/** Matches the letters of {@link TRANSLITERATIONS}. */
const TRANSLITERATED = /[ßẞæÆœŒøØđĐðÐłŁþÞı]/g;

/**
 * Spells the Latin letters that have no Unicode decomposition in ASCII (`ß` → `ss`, `Æ` → `AE`, `ł` → `l`…); other text is kept.
 * @param {string} text - The text
 * @returns {string} The text with those letters transliterated
 */
export function transliterate(text: string): string {
	return text.replace(TRANSLITERATED, function (letter: string): string {
		return TRANSLITERATIONS[letter];
	});
}
