/**
 * What a sheet is missing, if anything. A graphic the window could not paint is
 * reported rather than shipped blank: read as the graphic's own fault, it sent
 * an agent rewriting graphics that were fine.
 */
export function sheetWarning(
  primed: { loaded: number; expected: number },
  graphicsPainted: boolean,
): { warning?: string } {
  const parts: string[] = [];
  if (primed.loaded < primed.expected) {
    parts.push(
      `Only ${primed.loaded} of ${primed.expected} videos had decoded in time, so some frames may ` +
        `be missing their picture. Ask again: the decode continues in the background.`,
    );
  }
  if (!graphicsPainted) {
    parts.push(
      "The editor window did not paint in time, so HTML graphics may be missing from these frames. " +
        "That is the window, not the graphics: ask again, with Cartcut not minimised.",
    );
  }
  return parts.length > 0 ? { warning: parts.join(" ") } : {};
}
