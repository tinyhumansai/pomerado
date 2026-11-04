/** The most bytes a commit step's report may take as JSON. */
export const commitReportLimitBytes = 65_536;
/** The most levels a commit step's report may nest, counting each array and object. */
export const commitReportDepthLimit = 64;

/**
 * Whether `value` nests at most `commitReportDepthLimit` levels, counted without recursion so a
 * deep value can't overflow the stack.
 */
const nestsWithinLimit = (value: unknown) => {
  const pending: (readonly [unknown, number])[] = [[value, 0]];
  for (let next = pending.pop(); next !== undefined; next = pending.pop()) {
    const [item, depth] = next;
    if (typeof item !== "object" || item === null) continue;
    if (depth >= commitReportDepthLimit) return false;
    for (const child of Object.values(item)) pending.push([child, depth + 1]);
  }
  return true;
};

/**
 * A commit step's report as the host gets it, a copy through JSON, or why it can't go: it must be
 * JSON, fit in `commitReportLimitBytes` and nest at most `commitReportDepthLimit` levels, so the
 * channel to the host can carry it.
 */
export const commitReportValue = (
  report: unknown,
): { readonly value: unknown } | { readonly refused: string } => {
  let json: string | undefined;
  try {
    json = JSON.stringify(report);
  } catch {
    return { refused: "A commit step's report must be JSON" };
  }
  if (json === undefined) return { refused: "A commit step's report must be JSON" };
  if (new TextEncoder().encode(json).byteLength > commitReportLimitBytes)
    return {
      refused: `A commit step's report must fit in ${commitReportLimitBytes} bytes of JSON`,
    };
  const value = JSON.parse(json) as unknown;
  if (!nestsWithinLimit(value))
    return {
      refused: `A commit step's report must nest at most ${commitReportDepthLimit} levels deep`,
    };
  return { value };
};
