import { extendedGcd, findRoot, integerSqrt, linspace, niceDomain, primeFactors, summarize, ticks, toFraction } from 'tinkit/math';
import type { ExtendedGcd, FindRootOptions, LinspaceOptions, Summary } from 'tinkit/math';

const root: number = integerSqrt(17);
const bigRoot: bigint = integerSqrt(10n ** 40n);
// @ts-expect-error a number argument gives a number
const notBig: bigint = integerSqrt(17);
declare const either: number | bigint;
const eitherRoot: number | bigint = integerSqrt(either);
const bezout: ExtendedGcd = extendedGcd(240, 46);
// @ts-expect-error the coefficients are read-only
bezout.x = 0;
const [numerator, denominator]: [number, number] = toFraction(0.75);
const [low, high]: [number, number] = niceDomain(0.2, 9.7);
const findOptions: FindRootOptions = { tolerance: 1e-9, maxIterations: 50 };
const found: number = findRoot(Math.cos, 0, 3, findOptions);
// @ts-expect-error fn must return a number
findRoot(String, 0, 1);
const spaceOptions: LinspaceOptions = { endpoint: false };
const spaced: number[] = linspace(0, 1, 5, spaceOptions);
const tickValues: number[] = ticks(0, 1, 5);
const factors: number[] = primeFactors(360);
const summary: Summary = summarize([1, 2, 3]);
const spread: number = summary.q3 - summary.q1;
// @ts-expect-error unknown field
void summary.mode;
void [root, bigRoot, notBig, eitherRoot, numerator, denominator, low, high, found, spaced, tickValues, factors, spread];
