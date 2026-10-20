import { crc32, hmacSha256, hmacSha256Hex, JwtVerificationError, signJwt, verifyJwt } from 'tinkit/encoding';
import type { JwtHeader, JwtPayload, JwtVerificationErrorCode, SignJwtOptions, VerifiedJwt, VerifyJwtOptions } from 'tinkit/encoding';

const mac: Uint8Array<ArrayBuffer> = hmacSha256(new Uint8Array(32), 'message');
const macBuffer: ArrayBuffer = hmacSha256('key', new DataView(new ArrayBuffer(1))).buffer;
const macHex: string = hmacSha256Hex(new ArrayBuffer(8), new Uint16Array(2));
const checksum: number = crc32('chunk', crc32(new Uint8Array([1, 2])));
// @ts-expect-error keys are strings or binary data
hmacSha256(1, 'message');
// @ts-expect-error messages are strings or binary data
hmacSha256Hex('key', [1, 2]);
// @ts-expect-error the initial value is a number
crc32('x', '0');
// @ts-expect-error a SharedArrayBuffer itself is not accepted
crc32(new SharedArrayBuffer(1));

const signOptions: SignJwtOptions = { header: { kid: 'k1', typ: 'at+jwt', cty: 'JWT' }, expiresIn: 3600, notBefore: 0, timestamp: false, now: new Date() };
const token: string = signJwt({ sub: 'ada', roles: ['admin'] }, 'secret', signOptions) + signJwt({}, new Uint8Array(32), { now: 0 });
// @ts-expect-error the algorithm is always HS256
signJwt({}, 'secret', { header: { alg: 'none' } });
// @ts-expect-error expiresIn is a number of seconds
signJwt({}, 'secret', { expiresIn: '1h' });
// @ts-expect-error the payload is an object
signJwt('claims', 'secret');
// @ts-expect-error unknown option
signJwt({}, 'secret', { algorithm: 'HS256' });

const verifyOptions: VerifyJwtOptions = { now: 0, clockTolerance: 30, issuer: ['a', 'b'], audience: 'api', subject: 'ada', maxAge: 60, typ: 'JWT' };
const verified: VerifiedJwt = verifyJwt(token, 'secret', verifyOptions);
const header: JwtHeader = verified.header;
const payload: JwtPayload = verified.payload;
const expiry: number | undefined = verified.payload.exp;
interface Claims {
	readonly sub: string;
	readonly roles: readonly string[];
}
const typed: readonly string[] = verifyJwt<Claims>(token, new ArrayBuffer(32)).payload.roles;
// @ts-expect-error verifyJwt returns no signature
void verifyJwt(token, 'secret').signature;
// @ts-expect-error issuer is a string or an array of strings
verifyJwt(token, 'secret', { issuer: 1 });
// @ts-expect-error the secret is a string or binary data
verifyJwt(token, 1);

try {
	verifyJwt(token, 'secret');
} catch (error) {
	if (error instanceof JwtVerificationError) {
		const code: JwtVerificationErrorCode = error.code;
		const name: string = error.name;
		// @ts-expect-error the code is read-only
		error.code = 'expired';
		void [code, name];
	}
}
const codes: JwtVerificationErrorCode[] = ['malformed', 'invalid_algorithm', 'invalid_signature', 'expired', 'not_before', 'too_old', 'invalid_audience'];
// @ts-expect-error not a verification code
const unknownCode: JwtVerificationErrorCode = 'invalid_token';
const created: JwtVerificationError = new JwtVerificationError('verifyJwt: rejected', 'invalid_claim');

void [mac, macBuffer, macHex, checksum, token, header, payload, expiry, typed, codes, unknownCode, created];
