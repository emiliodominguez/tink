import { createHmac, timingSafeEqual as nodeTimingSafeEqual } from 'node:crypto';
import { crc32 as zlibCrc32 } from 'node:zlib';
import { crc32, hmacSha256, signJwt, verifyJwt } from 'tinkit/encoding';

// Inputs: a short message (a JWT signing input or a webhook body), 1 kB and 64 kB of pseudo-random bytes.
/**
 * Fills a buffer with deterministic pseudo-random bytes.
 * @param {number} length - Number of bytes
 * @returns {Uint8Array} The bytes
 */
function bytes(length) {
	const result = new Uint8Array(length);
	let state = 0x9e3779b9;
	for (let i = 0; i < length; i++) {
		state = (Math.imul(state, 1664525) + 1013904223) | 0;
		result[i] = state >>> 24;
	}
	return result;
}

const sizes = { '32 B': bytes(32), '1 kB': bytes(1024), '64 kB': bytes(65536) };
const key = bytes(32);
const secret = 'a-string-secret-at-least-256-bits-long';
const claims = { sub: 'user-123', role: 'admin', scope: ['read', 'write'] };
const token = signJwt(claims, secret, { expiresIn: 3600 });

/**
 * The textbook CRC-32: eight shift-and-xor steps per byte, no table.
 * @param {Uint8Array} data - The bytes
 * @returns {number} The checksum
 */
function bitwiseCrc32(data) {
	let crc = -1;
	for (let i = 0; i < data.length; i++) {
		crc ^= data[i];
		for (let bit = 0; bit < 8; bit++) crc = crc & 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
	}
	return ~crc >>> 0;
}

/** The usual one-table CRC-32 (one lookup per byte), built once. */
const byteTable = new Int32Array(256).map(function (_, n) {
	let crc = n;
	for (let bit = 0; bit < 8; bit++) crc = crc & 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
	return crc;
});

/**
 * CRC-32 with one table lookup per byte.
 * @param {Uint8Array} data - The bytes
 * @returns {number} The checksum
 */
function tableCrc32(data) {
	let crc = -1;
	for (let i = 0; i < data.length; i++) crc = byteTable[(crc ^ data[i]) & 255] ^ (crc >>> 8);
	return ~crc >>> 0;
}

/**
 * HS256 signing written directly against node:crypto.
 * @returns {string} The token
 */
function nodeSign() {
	const header = Buffer.from('{"alg":"HS256","typ":"JWT"}').toString('base64url');
	const now = Math.floor(Date.now() / 1000);
	const payload = Buffer.from(JSON.stringify({ ...claims, iat: now, exp: now + 3600 })).toString('base64url');
	const input = `${header}.${payload}`;
	return `${input}.${createHmac('sha256', secret).update(input).digest('base64url')}`;
}

/**
 * HS256 verification written directly against node:crypto (alg, signature and exp checks only).
 * @returns {object} The payload
 */
function nodeVerify() {
	const [header, payload, signature] = token.split('.');
	if (JSON.parse(Buffer.from(header, 'base64url').toString()).alg !== 'HS256') throw new Error('alg');
	const expected = createHmac('sha256', secret).update(`${header}.${payload}`).digest();
	const actual = Buffer.from(signature, 'base64url');
	if (actual.length !== expected.length || !nodeTimingSafeEqual(actual, expected)) throw new Error('signature');
	const claimsSet = JSON.parse(Buffer.from(payload, 'base64url').toString());
	if (claimsSet.exp * 1000 <= Date.now()) throw new Error('expired');
	return claimsSet;
}

export default [
	...Object.entries(sizes).map(function ([label, data]) {
		return {
			name: `hmacSha256 (${label})`,
			fn: function () {
				return hmacSha256(key, data);
			},
			competitors: {
				'node:crypto createHmac': function () {
					return createHmac('sha256', key).update(data).digest();
				}
			}
		};
	}),
	...Object.entries(sizes).map(function ([label, data]) {
		return {
			name: `crc32 (${label})`,
			fn: function () {
				return crc32(data);
			},
			baseline: function () {
				return bitwiseCrc32(data);
			},
			competitors: {
				'node:zlib crc32': function () {
					return zlibCrc32(data);
				},
				'one table lookup per byte': function () {
					return tableCrc32(data);
				}
			}
		};
	}),
	{
		name: 'signJwt (HS256, 3 claims)',
		fn: function () {
			return signJwt(claims, secret, { expiresIn: 3600 });
		},
		competitors: { 'node:crypto by hand': nodeSign }
	},
	{
		name: 'verifyJwt (HS256, exp)',
		fn: function () {
			return verifyJwt(token, secret);
		},
		competitors: { 'node:crypto by hand': nodeVerify }
	}
];
