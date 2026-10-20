import { ciede2000, colorFromString, deltaE, simulateColorVisionDeficiency, toLab } from 'tinkit/color';
import type { ColorFromStringOptions, ColorVisionDeficiency, DeltaEMethod, DeltaEOptions, Lab, Rgba } from 'tinkit/color';

const method: DeltaEMethod = '2000';
const options: DeltaEOptions = { method };
const ok: number = deltaE('#ff0000', { r: 0, g: 0, b: 255 });
const cie2000: number = deltaE('#ff0000', '#0000ff', options);
const cie76: number = deltaE('#ff0000', '#0000ff', { method: '76' });
const lab: Required<Lab> = toLab('#bada55');
const labAlpha: number = lab.alpha;
const fromLab: number = ciede2000(lab, { l: 50, a: 2.5, b: 0 });
// @ts-expect-error unknown deltaE method
deltaE('#000', '#fff', { method: 'cmc' });
// @ts-expect-error the method is a string
deltaE('#000', '#fff', { method: 2000 });
// @ts-expect-error Lab objects need a b component
ciede2000({ l: 50, a: 0 }, lab);

// The format decides the result type.
const hex: string = colorFromString('Ada Lovelace');
const explicitHex: string = colorFromString('Ada Lovelace', { format: 'hex', lightness: [0.5, 0.7], chroma: 0.1, hueRange: [200, 260] });
const object: Rgba = colorFromString('Ada Lovelace', { format: 'rgb', contrastWith: '#fff', minContrast: 4.5 });
const settings: ColorFromStringOptions = { contrastWith: { r: 0, g: 0, b: 0 } };
const either: string | Rgba = colorFromString('Ada Lovelace', settings);
// @ts-expect-error an Rgba object is not a string
const notHex: string = colorFromString('Ada Lovelace', { format: 'rgb' });
// @ts-expect-error unknown format
colorFromString('Ada Lovelace', { format: 'hsl' });
// @ts-expect-error ranges are pairs
colorFromString('Ada Lovelace', { lightness: [0.5] });
// @ts-expect-error the text must be a string
colorFromString(42);

const deficiency: ColorVisionDeficiency = 'deuteranopia';
const simulated: Rgba = simulateColorVisionDeficiency('#ff0000', deficiency, 0.5);
const full: Rgba = simulateColorVisionDeficiency({ r: 255, g: 0, b: 0, a: 0.5 }, 'achromatopsia');
// @ts-expect-error unknown deficiency
simulateColorVisionDeficiency('#ff0000', 'colorblind');
// @ts-expect-error the severity is a number
simulateColorVisionDeficiency('#ff0000', 'protanopia', '1');
void [ok, cie2000, cie76, labAlpha, fromLab, hex, explicitHex, object, either, notHex, simulated, full];
