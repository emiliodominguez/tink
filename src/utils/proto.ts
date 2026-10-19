/**
 * PRIVATE prototype-pollution helper shared by the encoding module (`decodeJwt`) and the store module (`persistStore`). Not part of the
 * public API: this file is not re-exported by `utils/index.ts` or the package root, and the `exports` map does not reach it.
 * @internal
 * @packageDocumentation
 */

/**
 * A `JSON.parse` reviver that drops the keys through which parsed data could pollute prototypes once it is copied (`Object.assign`, a
 * naive deep merge): `__proto__`, and a `constructor` holding an object with a `prototype` key. These are the keys `parseJson`
 * (validate) removes with `proto: 'remove'`.
 * @param {string} key - The property name
 * @param {unknown} value - Its (already revived) value
 * @returns {unknown} `undefined` (which deletes the property) for those keys, else `value`
 */
export function withoutProtoKeys(key: string, value: unknown): unknown {
	const polluting = key === '__proto__' || (key === 'constructor' && typeof value === 'object' && value !== null && Object.hasOwn(value, 'prototype'));
	return polluting ? undefined : value;
}
