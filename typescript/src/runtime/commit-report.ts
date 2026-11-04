/** The most bytes a commit step's report may take as JSON. */
export const commitReportLimitBytes = 65_536;

/**
 * A commit step's report as the host gets it, a copy through JSON, or why it can't go: it must be
 * JSON and fit in `commitReportLimitBytes`.
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
  return { value: JSON.parse(json) as unknown };
};
