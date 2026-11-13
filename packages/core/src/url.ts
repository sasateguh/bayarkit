/**
 * `https://host/v3///` → `https://host/v3`. A loop, not `/\/+$/`: that regex backtracks quadratically on a long run
 * of slashes that is not at the end (CodeQL js/polynomial-redos), even though a base URL is the developer's own config.
 */
export function withoutTrailingSlashes(url: string): string {
  let end = url.length
  while (end > 0 && url.charCodeAt(end - 1) === 47) end--
  return url.slice(0, end)
}
