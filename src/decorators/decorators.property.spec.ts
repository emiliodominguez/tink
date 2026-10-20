import fc from 'fast-check';
import { lazy, measure, type Measurement } from '.';

/** One step of a `@lazy` scenario: read the getter of an instance, delete its cached value, or freeze it. */
type LazyStep = { kind: 'read' | 'delete' | 'freeze'; instance: number };

describe('decorators (properties)', function () {
	it('@lazy runs the getter once per instance until its cached value is deleted, returning what a plain getter would', function () {
		fc.assert(
			fc.property(
				fc.integer({ min: 1, max: 4 }),
				fc.array(fc.record({ kind: fc.constantFrom<LazyStep['kind']>('read', 'read', 'read', 'delete', 'freeze'), instance: fc.nat(3) }), { maxLength: 40 }),
				function (count, steps) {
					const runs: number[] = [];
					class Subject {
						constructor(readonly id: number) {}

						@lazy
						get value(): string {
							runs.push(this.id);
							return `value of ${this.id}`;
						}
					}
					const instances = Array.from({ length: count }, function (_, id) {
						return new Subject(id);
					});
					// Model: whether each instance has a cached value, and whether it is frozen (then deletes fail and the value stays cached).
					const cached = instances.map(function () {
						return false;
					});
					const frozen = cached.slice();
					const expectedRuns: number[] = [];
					for (const step of steps) {
						const index = step.instance % count;
						const instance = instances[index];
						if (step.kind === 'read') {
							if (!cached[index]) expectedRuns.push(index);
							cached[index] = true;
							expect(instance.value).toBe(`value of ${index}`);
						} else if (step.kind === 'delete') {
							// Frozen instances keep the value in a WeakMap: there is no own property to delete.
							if (!frozen[index]) cached[index] = false;
							Reflect.deleteProperty(instance, 'value');
						} else {
							Object.freeze(instance);
							frozen[index] = true;
						}
					}
					expect(runs).toEqual(expectedRuns);
					instances.forEach(function (instance) {
						expect(Object.keys(instance)).toEqual(['id']);
					});
				}
			)
		);
	});

	it('@measure keeps every outcome and reports each call once, with the duration the clock gives', async function () {
		await fc.assert(
			fc.asyncProperty(
				fc.array(fc.record({ fails: fc.boolean(), async: fc.boolean(), value: fc.anything(), elapsed: fc.nat(1000) }), { maxLength: 10 }),
				async function (calls) {
					const measurements: Measurement[] = [];
					let time = 0;
					class Subject {
						@measure({
							clock: function (): number {
								return time;
							},
							onMeasure: function (measurement: Measurement): void {
								measurements.push(measurement);
							}
						})
						run(index: number): unknown {
							const call = calls[index];
							if (!call.async) {
								time += call.elapsed;
								if (call.fails) throw call.value;
								return call.value;
							}
							return Promise.resolve().then(function (): unknown {
								time += call.elapsed;
								if (call.fails) throw call.value;
								return call.value;
							});
						}
					}
					const subject = new Subject();
					for (let index = 0; index < calls.length; index++) {
						const call = calls[index];
						let outcome: { fails: boolean; value: unknown };
						try {
							outcome = { fails: false, value: await subject.run(index) };
						} catch (error) {
							outcome = { fails: true, value: error };
						}
						expect(outcome.fails).toBe(call.fails);
						expect(Object.is(outcome.value, call.value)).toBe(true);
						expect(measurements).toHaveLength(index + 1);
						const measurement = measurements[index];
						expect(measurement.name).toBe('run');
						expect(measurement.duration).toBe(call.elapsed);
						expect(measurement.args).toEqual([index]);
						expect(measurement.failed).toBe(call.fails);
						expect(Object.is(measurement.error, call.fails ? call.value : undefined)).toBe(true);
					}
				}
			)
		);
	});
});
