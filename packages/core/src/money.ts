/** 1050 → "10.50". */
export function toRinggit(sen: number): string {
  if (!Number.isInteger(sen)) throw new RangeError(`amount must be integer sen, got ${sen}`)
  return (sen / 100).toFixed(2)
}

/** "10.50" / "10.5" / 10.5 → 1050. `NaN` when the value is not a finite number. */
export function toSen(ringgit: unknown): number {
  if (typeof ringgit !== 'number' && typeof ringgit !== 'string') return Number.NaN
  if (typeof ringgit === 'string' && ringgit.trim() === '') return Number.NaN
  const n = Number(ringgit)
  return Number.isFinite(n) ? Math.round(n * 100) : Number.NaN
}
