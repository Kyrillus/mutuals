/**
 * oklch → sRGB → WCAG relative luminance.
 *
 * This exists so `contrast.test.ts` can check the palette in `globals.css` for real instead of
 * taking a comment's word for it. Nothing in the running app imports it: the browser does this
 * conversion itself, and it is only interesting at build time, where the answer is an assertion.
 *
 * The matrices are Björn Ottosson's Oklab definition and the sRGB primaries; the two-step
 * "encode, then re-linearise" in `relativeLuminance` is deliberate and explained there.
 */

export interface Oklch {
  readonly l: number
  /** Chroma. */
  readonly c: number
  /** Hue in degrees. */
  readonly h: number
}

export type Rgb = readonly [r: number, g: number, b: number]

function encodeGamma(channel: number): number {
  const encoded =
    channel <= 0.0031308 ? 12.92 * channel : 1.055 * Math.abs(channel) ** (1 / 2.4) - 0.055
  // Clamping is not cosmetic: a colour outside the sRGB gamut is *displayed* clipped, so the
  // contrast a person actually sees is the contrast of the clipped colour.
  return Math.min(1, Math.max(0, encoded))
}

function decodeGamma(channel: number): number {
  return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4
}

export function oklchToSrgb({ l, c, h }: Oklch): Rgb {
  const radians = (h * Math.PI) / 180
  const a = c * Math.cos(radians)
  const b = c * Math.sin(radians)

  const longRoot = l + 0.3963377774 * a + 0.2158037573 * b
  const mediumRoot = l - 0.1055613458 * a - 0.0638541728 * b
  const shortRoot = l - 0.0894841775 * a - 1.291485548 * b

  const long = longRoot ** 3
  const medium = mediumRoot ** 3
  const short = shortRoot ** 3

  return [
    encodeGamma(4.0767416621 * long - 3.3077115913 * medium + 0.2309699292 * short),
    encodeGamma(-1.2684380046 * long + 2.6097574011 * medium - 0.3413193965 * short),
    encodeGamma(-0.0041960863 * long - 0.7034186147 * medium + 1.707614701 * short),
  ]
}

export function relativeLuminance([r, g, b]: Rgb): number {
  return 0.2126 * decodeGamma(r) + 0.7152 * decodeGamma(g) + 0.0722 * decodeGamma(b)
}

/** WCAG 2.1 contrast ratio, 1:1 to 21:1. */
export function contrastRatio(a: Rgb, b: Rgb): number {
  const first = relativeLuminance(a)
  const second = relativeLuminance(b)
  return (Math.max(first, second) + 0.05) / (Math.min(first, second) + 0.05)
}

export function toHex([r, g, b]: Rgb): string {
  const channel = (value: number): string =>
    Math.round(value * 255)
      .toString(16)
      .padStart(2, '0')
  return `#${channel(r)}${channel(g)}${channel(b)}`
}

const OKLCH_PATTERN =
  /^oklch\(\s*([\d.]+%?)\s+([\d.]+%?)\s+([\d.]+)(?:deg)?\s*(?:\/\s*[\d.]+%?\s*)?\)$/

/**
 * Parses the one notation `globals.css` uses. It deliberately does not accept `hsl()`, `#rrggbb`
 * or `color-mix()`: a token written in another notation is a token that escaped the palette, and
 * the test should fail loudly rather than skip it.
 *
 * The optional alpha is accepted and then ignored — the translucent hairline tokens are borders,
 * never text — so parsing the file never needs a special case for them.
 */
export function parseOklch(value: string): Oklch | null {
  const match = OKLCH_PATTERN.exec(value.trim())
  if (match === null) return null

  const [, rawL, rawC, rawH] = match
  if (rawL === undefined || rawC === undefined || rawH === undefined) return null

  // Lightness is a ratio in one form and a percentage in the other; chroma follows the same rule,
  // where 100% means 0.4.
  const l = rawL.endsWith('%') ? Number(rawL.slice(0, -1)) / 100 : Number(rawL)
  const c = rawC.endsWith('%') ? (Number(rawC.slice(0, -1)) / 100) * 0.4 : Number(rawC)
  const h = Number(rawH)

  if (!Number.isFinite(l) || !Number.isFinite(c) || !Number.isFinite(h)) return null
  return { l, c, h }
}
