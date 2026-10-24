/** Internal helpers for validating untrusted wire data. Not exported from the package. */
export const plain = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" &&
  value !== null &&
  !Array.isArray(value) &&
  (Object.getPrototypeOf(value) === Object.prototype ||
    Object.getPrototypeOf(value) === null);

/** Reports, in the given key order, each missing key and then each unknown key. */
export function keyIssues(
  value: Record<string, unknown>,
  keys: readonly string[],
  path: string,
): string[] {
  const missing = keys.filter((key) => !Object.hasOwn(value, key));
  const unknown = Object.keys(value)
    .filter((key) => !keys.includes(key))
    .sort();
  return [...missing, ...unknown].map((key) => join(path, key));
}

export const join = (path: string, key: string) =>
  path ? `${path}.${key}` : key;

export const ID_MAX_LENGTH = 64;
// eslint-disable-next-line no-control-regex -- Reject control characters in untrusted identifiers.
const idPattern = /^[^\u0000-\u001f\u007f\s<>]+$/u;

/** Catalog identifiers are opaque: UUIDs in the API, readable slugs in fixtures. */
export const isId = (value: unknown): value is string =>
  typeof value === "string" &&
  value.length > 0 &&
  value.length <= ID_MAX_LENGTH &&
  idPattern.test(value);

export const isCents = (value: unknown, min = 0): value is number =>
  Number.isSafeInteger(value) && (value as number) >= min;
