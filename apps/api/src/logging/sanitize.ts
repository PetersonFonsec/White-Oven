/**
 * Free-text sanitization for log output. Exception and library messages (database
 * drivers, HTTP clients, Nest internals) can echo input values; these patterns mask the
 * shapes of personal data and credentials while keeping the rest of the text readable.
 */
const MAX_TEXT_LENGTH = 500;

const TEXT_RULES: ReadonlyArray<[RegExp, string]> = [
  // scheme://user:password@host
  [/\b([a-z][a-z0-9+.-]*:\/\/)[^\s:@/]+:[^\s@/]*@/gi, "$1[CREDENTIALS]@"],
  [/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*/g, "[JWT]"],
  [/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/gi, "$1 [REDACTED]"],
  [
    /\b(password|passwd|pwd|secret|token|api[_-]?key|authorization|cookie)(\s*[=:]\s*)("[^"]*"|'[^']*'|[^\s,;&]+)/gi,
    "$1$2[REDACTED]",
  ],
  [/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, "[EMAIL]"],
  // Query strings with parameters.
  [/\?[^\s"'?#]*=[^\s"']*/g, "?[QUERY]"],
  // PostgreSQL constraint details: Key (column)=(value).
  [/\)=\([^)]*\)/g, ")=([REDACTED])"],
  // Quoted literals (SQL values, echoed input); apostrophes inside words are kept.
  [/(?<![A-Za-z0-9])'[^'\n]*'(?![A-Za-z0-9])/g, "'[REDACTED]'"],
  [/(?<![A-Za-z0-9])"[^"\n]*"(?![A-Za-z0-9])/g, '"[REDACTED]"'],
  // Phone, CPF, card and other long numbers, including separators.
  [/(?<![\w.])\+?\d[\d .()/-]{8,}\d(?![\w])/g, "[NUMBER]"],
];

export function sanitizeText(text: string): string {
  let result = text
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .slice(0, MAX_TEXT_LENGTH * 2);
  for (const [pattern, replacement] of TEXT_RULES) {
    result = result.replace(pattern, replacement);
  }
  return result.length > MAX_TEXT_LENGTH
    ? `${result.slice(0, MAX_TEXT_LENGTH)}…`
    : result;
}

/**
 * Stack frames only (`at ...` lines). The first line of `Error#stack` repeats the
 * message, and multi-line messages continue on the following lines, so slicing the
 * stack by position would leak them.
 */
export function stackFrames(stack: string | undefined, limit = 10): string[] {
  if (!stack) return [];
  return stack
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.startsWith("at "))
    .slice(0, limit)
    .map(sanitizeText);
}

/** Loggable description of any thrown value: its type and frames, never its message. */
export function describeError(error: unknown): {
  errorType: string;
  frames: string[];
} {
  return error instanceof Error
    ? { errorType: error.constructor.name, frames: stackFrames(error.stack) }
    : { errorType: typeof error, frames: [] };
}
