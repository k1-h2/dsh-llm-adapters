/**
 * Shared model-name rules for every provider.
 *
 * Upstream catalogs are inconsistent: Loomy embeds the multiplier and promo
 * text in parentheses, Raccoon writes `GLM-5-3` where the product is `GLM 5.3`,
 * and both mix full-width and half-width punctuation. The settings page wants a
 * clean product name, a price badge and a few labels, and OpenRouter matching
 * wants a stable comparison key — so all of that is derived here instead of
 * being special-cased per provider.
 *
 * @module dsh-llm-adapters/model-name
 */

const BRACKET_PATTERN = /[(（]([^()（）]*)[)）]/g
const MULTIPLIER_PATTERN = /^(?:[x×]\s*([0-9]+(?:\.[0-9]+)?)|([0-9]+(?:\.[0-9]+)?)\s*倍)$/i

/** `x3.0`, `× 0.1`, `3倍`, optionally inside parentheses or after a space. */
export function priceFactorOf(text: string): number | undefined {
  const match = /(?:^|[\s·(（])(?:[x×]\s*([0-9]+(?:\.[0-9]+)?)|([0-9]+(?:\.[0-9]+)?)\s*倍)/i.exec(text)
  if (match === null) return undefined
  const value = Number(match[1] ?? match[2])
  return Number.isFinite(value) ? value : undefined
}

/** A bracket that contains nothing but a multiplier is a price, not a label. */
function multiplierOf(text: string): number | undefined {
  const match = MULTIPLIER_PATTERN.exec(text.trim())
  if (match === null) return undefined
  const value = Number(match[1] ?? match[2])
  return Number.isFinite(value) ? value : undefined
}

function normalizeSeparators(value: string): string {
  return value
    // `GLM-5-3` means version 5.3, so a hyphen between digits becomes a dot.
    .replace(/(\d)\s*-\s*(\d)/g, '$1.$2')
    // Every other hyphen (Kimi-K3, DeepSeek-V4.1-Flash) reads as a word break.
    .replace(/-/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

export interface ParsedModelName {
  /** Clean product name with brackets and version hyphens removed. */
  name: string
  /** Non-price bracket contents, in upstream order. */
  labels: string[]
  /** Multiplier found in a bracket, if any. */
  priceFactor?: number
}

/**
 * Normalize one upstream display name.
 *
 * - `(x0.0)` / `（x0.8）` is the price, so it is removed from the name instead
 *   of being repeated there; the settings page renders it after the labels.
 * - Any other bracket content becomes a label (`(限时免费)` → `限时免费`), so it
 *   can sit next to the 读图 / 思考 tags.
 * - Hyphens between digits become dots (`GLM-5-3` → `GLM 5.3`); other hyphens
 *   become spaces (`Kimi-K3` → `Kimi K3`).
 */
export function parseModelName(raw: string): ParsedModelName {
  const labels: string[] = []
  let priceFactor: number | undefined
  for (const match of raw.matchAll(BRACKET_PATTERN)) {
    const content = match[1]!.trim()
    if (content.length === 0) continue
    const price = multiplierOf(content)
    if (price !== undefined) {
      if (priceFactor === undefined) priceFactor = price
      continue
    }
    if (!labels.includes(content)) labels.push(content)
  }
  const withoutBrackets = raw.replace(BRACKET_PATTERN, ' ')
  const name = normalizeSeparators(withoutBrackets) || normalizeSeparators(raw)
  return {
    name,
    labels,
    ...priceFactor === undefined ? {} : { priceFactor },
  }
}

/** Comparison key shared by upstream names, upstream ids and OpenRouter. */
export function modelKey(value: string): string {
  return parseModelName(value).name
    .toLowerCase()
    .replace(/^sn\s+/, '')
    .replace(/[^a-z0-9]/g, '')
}
