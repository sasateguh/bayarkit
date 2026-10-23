import { timingSafeEqual } from 'node:crypto'

/** Constant-time comparison of two strings; different lengths are simply unequal. */
export function timingSafeEqualText(a: string, b: string): boolean {
  const x = Buffer.from(a)
  const y = Buffer.from(b)
  return x.length === y.length && timingSafeEqual(x, y)
}
