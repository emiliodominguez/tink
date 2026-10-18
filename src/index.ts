/**
 * tink — strictly-typed, zero-dependency TypeScript utilities.
 *
 * Every module is exposed as a namespace to avoid name collisions (e.g. `strings.isEmpty` vs `objects.isEmpty`).
 * Prefer deep imports (`@emiliodominguez/tink/arrays`) for the best tree-shaking.
 * @packageDocumentation
 */
export * as arrays from './arrays/index.js';
export * as async from './async/index.js';
export * as cache from './cache/index.js';
export * as color from './color/index.js';
export * as date from './date/index.js';
export * as decorators from './decorators/index.js';
export * as easing from './easing/index.js';
export * as emitter from './emitter/index.js';
export * as format from './format/index.js';
export * as functions from './functions/index.js';
export * as guards from './guards/index.js';
export * as iterables from './iterables/index.js';
export * as math from './math/index.js';
export * as objects from './objects/index.js';
export * as random from './random/index.js';
export * as search from './search/index.js';
export * as store from './store/index.js';
export * as strings from './strings/index.js';
export * as url from './url/index.js';
export * as validate from './validate/index.js';
export type * from './utils/index.js';
