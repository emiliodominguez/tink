// @lazy and @measure as TC39 standard decorators (the default without experimentalDecorators), from the published declarations.
import { lazy, measure } from 'tinkit/decorators';
import type { Measurement, MeasureOptions } from 'tinkit/decorators';

const options: MeasureOptions = {
	name: 'load',
	clock: function (): number {
		return 0;
	},
	onMeasure: function (measurement: Measurement): void {
		const duration: number = measurement.duration;
		const failed: boolean = measurement.failed;
		const args: readonly unknown[] = measurement.args;
		void [duration, failed, args];
	}
};

class Report {
	rows: number[] = [];

	@lazy
	get total(): number {
		return this.rows.length;
	}

	@lazy
	static get shared(): string {
		return 'shared';
	}

	@lazy
	get #secret(): number {
		return 1;
	}

	@measure
	parse(text: string): unknown {
		return JSON.parse(text);
	}

	@measure(options)
	async load(id: number): Promise<string> {
		return `user ${id}`;
	}

	@measure()
	self(this: Report): number {
		return this.#secret;
	}
}

const report = new Report();
const total: number = report.total;
const shared: string = Report.shared;
const loaded: Promise<string> = report.load(1);
// @ts-expect-error `name` is a string
measure({ name: 1 });

export { total, shared, loaded };
