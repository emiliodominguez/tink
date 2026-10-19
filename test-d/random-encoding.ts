import { toBase64, fromBase64, toHex, fromHex, encodeUtf8, decodeUtf8, sha256, sha256Hex } from 'tinkit/encoding';
import type { BytesInput, ToBase64Options, FromBase64Options, Base64Padding, DecodeUtf8Options } from 'tinkit/encoding';
import { uuidv7, createUuidv7, uuidv7Timestamp, ulid, createUlid, ulidTimestamp, createRandom, randomBytes } from 'tinkit/random';
import type { TimeIdOptions } from 'tinkit/random';

const encodedBase64: string = toBase64(new Uint8Array([1]), { urlSafe: true, padding: false }) + toBase64('text') + toBase64(new ArrayBuffer(2));
const encodedHex: string = toHex(new DataView(new ArrayBuffer(2)));
const decodedBytes: Uint8Array[] = [fromBase64('AA==', { padding: 'required' }), fromHex('00'), encodeUtf8('é', { fatal: true }), sha256('abc')];
// Byte results are backed by a plain ArrayBuffer (like `TextEncoder#encode`), so they fit `crypto.subtle`, `Blob` and `BufferSource` slots.
const ownBuffers: ArrayBuffer[] = [fromBase64('AA==').buffer, fromHex('00').buffer, encodeUtf8('x').buffer, sha256('x').buffer, randomBytes(1).buffer];
const decodedText: string = decodeUtf8(new Uint16Array(2), { fatal: true, stripBom: true }) + sha256Hex(new Uint8Array(0));
const padding: Base64Padding = 'forbidden';
const bytesInput: BytesInput = new Float64Array(1);
const encodingOptions: [ToBase64Options, FromBase64Options, DecodeUtf8Options] = [{ urlSafe: true }, { padding }, { stripBom: true }];
// @ts-expect-error numbers are not binary data
toBase64(5);
// @ts-expect-error arrays of numbers are not binary data
toHex([1, 2]);
// @ts-expect-error decodeUtf8 takes bytes, not strings
decodeUtf8('abc');
// @ts-expect-error padding is a boolean when encoding
toBase64('a', { padding: 'required' });
// @ts-expect-error padding is a mode when decoding
fromBase64('a', { padding: true });
// @ts-expect-error a SharedArrayBuffer itself is not accepted
sha256(new SharedArrayBuffer(1));
// @ts-expect-error fromHex takes text
fromHex(new Uint8Array(1));

const nextUuid: () => string = createUuidv7({ now: Date.now, random: createRandom('seed') });
const nextUlid: () => string = createUlid();
const createdAt: number = uuidv7Timestamp(nextUuid()) + ulidTimestamp(nextUlid()) + uuidv7().length + ulid().length;
const timeIdOptions: TimeIdOptions = {
	now: function () {
		return 0;
	}
};
// @ts-expect-error now must be a function
createUuidv7({ now: 5 });
// @ts-expect-error random must be a function
createUlid({ random: 0.5 });
// @ts-expect-error unknown option
createUlid({ seed: 1 });
// @ts-expect-error uuidv7 takes no options
uuidv7({ now: Date.now });
// @ts-expect-error options must be an object
createUuidv7(null);
// @ts-expect-error boolean options are booleans
toBase64('a', { urlSafe: 'false' });
void [encodedBase64, encodedHex, decodedBytes, ownBuffers, decodedText, bytesInput, encodingOptions, createdAt, timeIdOptions];
