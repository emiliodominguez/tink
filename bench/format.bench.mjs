import {
	formatCompact,
	formatCurrency,
	formatDateTime,
	formatList,
	formatNumber,
	formatOrdinal,
	formatPercent,
	formatRelativeTime,
	formatUnit,
	pluralRule
} from 'tinkit/format';

// Competitors: constructing the `Intl` formatter on every call (what a naive helper does), and reusing one formatter built ahead of
// time (the theoretical best, which a helper taking options per call cannot reach: it must at least look its cached formatter up).
const instant = Date.UTC(2024, 0, 15, 13, 45);
const items = ['apples', 'bananas', 'cherries'];

/**
 * Builds a case with the two standard competitors.
 * @param {string} name - The case name
 * @param {() => string} fn - Our call
 * @param {() => { format: (value: unknown) => string }} create - Constructs the equivalent `Intl` formatter
 * @param {unknown} value - The formatted value
 * @returns {object} The case
 */
function intlCase(name, fn, create, value) {
	const prebuilt = create();
	return {
		name,
		fn,
		competitors: {
			'new Intl per call': function () {
				return create().format(value);
			},
			'prebuilt Intl': function () {
				return prebuilt.format(value);
			}
		}
	};
}

export default [
	intlCase(
		'formatNumber (no options)',
		function () {
			return formatNumber(1234567.891);
		},
		function () {
			return new Intl.NumberFormat('en-US');
		},
		1234567.891
	),
	intlCase(
		'formatNumber (locale + 1 option)',
		function () {
			return formatNumber(1234.5, { locale: 'de-DE', minimumFractionDigits: 2 });
		},
		function () {
			return new Intl.NumberFormat(['de-DE', 'en-US'], { minimumFractionDigits: 2 });
		},
		1234.5
	),
	intlCase(
		'formatNumber (3 options)',
		function () {
			return formatNumber(0.5, { minimumFractionDigits: 1, maximumFractionDigits: 3, signDisplay: 'always' });
		},
		function () {
			return new Intl.NumberFormat('en-US', { minimumFractionDigits: 1, maximumFractionDigits: 3, signDisplay: 'always' });
		},
		0.5
	),
	intlCase(
		'formatCurrency (USD)',
		function () {
			return formatCurrency(1234.5, 'USD');
		},
		function () {
			return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' });
		},
		1234.5
	),
	intlCase(
		'formatPercent (decimals: 1)',
		function () {
			return formatPercent(0.256, { decimals: 1 });
		},
		function () {
			return new Intl.NumberFormat('en-US', { style: 'percent', minimumFractionDigits: 1, maximumFractionDigits: 1 });
		},
		0.256
	),
	intlCase(
		'formatCompact (no options)',
		function () {
			return formatCompact(3_400_000);
		},
		function () {
			return new Intl.NumberFormat('en-US', { notation: 'compact' });
		},
		3_400_000
	),
	intlCase(
		'formatUnit (km/h)',
		function () {
			return formatUnit(50, 'kilometer-per-hour');
		},
		function () {
			return new Intl.NumberFormat('en-US', { style: 'unit', unit: 'kilometer-per-hour' });
		},
		50
	),
	intlCase(
		'formatDateTime (no options)',
		function () {
			return formatDateTime(instant);
		},
		function () {
			return new Intl.DateTimeFormat('en-US', { timeZone: 'UTC' });
		},
		instant
	),
	intlCase(
		'formatDateTime (dateStyle)',
		function () {
			return formatDateTime(instant, { dateStyle: 'medium' });
		},
		function () {
			return new Intl.DateTimeFormat('en-US', { dateStyle: 'medium', timeZone: 'UTC' });
		},
		instant
	),
	intlCase(
		'formatList (3 items)',
		function () {
			return formatList(items);
		},
		function () {
			return new Intl.ListFormat('en-US');
		},
		items
	),
	{
		name: 'formatRelativeTime (-2 hours)',
		fn: function () {
			return formatRelativeTime(-2, 'hour');
		},
		competitors: (function () {
			const prebuilt = new Intl.RelativeTimeFormat('en-US');
			return {
				'new Intl per call': function () {
					return new Intl.RelativeTimeFormat('en-US').format(-2, 'hour');
				},
				'prebuilt Intl': function () {
					return prebuilt.format(-2, 'hour');
				}
			};
		})()
	},
	{
		name: 'formatOrdinal',
		fn: function () {
			return formatOrdinal(22);
		},
		competitors: (function () {
			const suffixes = { one: 'st', two: 'nd', few: 'rd', other: 'th' };
			const rules = new Intl.PluralRules('en-US', { type: 'ordinal' });
			const numbers = new Intl.NumberFormat('en-US');
			return {
				'new Intl per call': function () {
					return new Intl.NumberFormat('en-US').format(22) + suffixes[new Intl.PluralRules('en-US', { type: 'ordinal' }).select(22)];
				},
				'prebuilt Intl': function () {
					return numbers.format(22) + suffixes[rules.select(22)];
				}
			};
		})()
	},
	{
		name: 'pluralRule',
		fn: function () {
			return pluralRule(2);
		},
		competitors: (function () {
			const prebuilt = new Intl.PluralRules('en-US');
			return {
				'new Intl per call': function () {
					return new Intl.PluralRules('en-US').select(2);
				},
				'prebuilt Intl': function () {
					return prebuilt.select(2);
				}
			};
		})()
	}
];
