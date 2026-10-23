/** 1050 → "10.50". Integer arithmetic only, so no float ever decides a digit. */
export function toRinggit(sen: number): string {
  if (!Number.isInteger(sen)) throw new RangeError(`amount must be integer sen, got ${sen}`)
  const abs = Math.abs(sen)
  return `${sen < 0 ? '-' : ''}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, '0')}`
}

/**
 * "10.50" / "10.5" / 10.5 → 1050. A string is parsed as a decimal, never through a float (a third decimal rounds half
 * up: "10.505" → 1051); `NaN` when it is not a plain number ("1,050.00", "1e3", ".5", "RM10") or too large
 * to be a safe integer of sen. The PHP twin
 * (`Bayarkit\Money::toSen`) agrees on every row of test/money-vectors.json.
 */
export function toSen(ringgit: unknown): number {
  if (typeof ringgit === 'number') {
    const sen = Math.round(ringgit * 100)
    return Number.isSafeInteger(sen) ? sen : Number.NaN
  }
  if (typeof ringgit !== 'string') return Number.NaN
  const m = /^\s*(-?)(\d+)(?:\.(\d*))?\s*$/.exec(ringgit)
  // ≥ 10^14 ringgit cannot be a safe-integer number of sen; checked on the text, before any arithmetic.
  if (!m || (m[2] as string).replace(/^0+/, '').length > 14) return Number.NaN
  const decimals = (m[3] ?? '').padEnd(3, '0')
  const sen = Number(m[2]) * 100 + Number(decimals.slice(0, 2)) + (Number(decimals[2]) >= 5 ? 1 : 0)
  if (!Number.isSafeInteger(sen)) return Number.NaN
  return m[1] === '-' ? -sen : sen
}
