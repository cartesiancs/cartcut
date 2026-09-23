/**
 * The Extensions menu, as data.
 *
 * Its own file for the reason `lib/menuCommands.ts` is one: `menu.ts` imports
 * Electron and cannot be loaded by a test, while the decisions worth pinning
 * here are about grouping, ordering and escaping untrusted labels. A menu
 * label comes from a stranger's manifest and ends up in a native menu, so
 * capping its length and stripping the characters that would break the row is
 * a rule, not a nicety.
 */

export type ContributedMenuItem = {
  extId: string;
  commandId: string;
  label: string;
};

export type ContributedMenuGroup = {
  extId: string;
  displayName: string;
  items: ContributedMenuItem[];
};

/** A native menu row is one line. Longer is a paragraph in a menu. */
export const MAX_MENU_LABEL = 80;

function cleanLabel(value: unknown): string {
  if (typeof value !== "string") {
    return "";
  }
  // Newlines and tabs are what turn one row into something that overflows the
  // menu on some platforms and renders as a box on others.
  const flat = value.replace(/[\r\n\t]+/g, " ").trim();
  return flat.length > MAX_MENU_LABEL ? flat.slice(0, MAX_MENU_LABEL - 1) + "…" : flat;
}

type RawContribution = {
  extId: string;
  displayName: string;
  /** `[{ command, title }]`, as the host sent it. */
  items: unknown;
};

/**
 * Group what every extension contributed, dropping what does not fit.
 *
 * An extension that contributes no valid item gets no submenu at all rather
 * than an empty one: an empty submenu is a row the user can open and find
 * nothing in, which reads as a bug in the app rather than in the extension.
 */
export function buildMenuGroups(contributions: readonly RawContribution[]): ContributedMenuGroup[] {
  const groups: ContributedMenuGroup[] = [];

  for (const contribution of contributions) {
    const raw = Array.isArray(contribution.items) ? contribution.items : [];
    const items: ContributedMenuItem[] = [];

    for (const entry of raw) {
      if (entry == null || typeof entry !== "object") {
        continue;
      }
      const record = entry as Record<string, unknown>;
      const commandId = typeof record.command === "string" ? record.command : "";
      const label = cleanLabel(record.title);
      if (commandId === "" || label === "") {
        continue;
      }
      items.push({ extId: contribution.extId, commandId, label });
    }

    if (items.length > 0) {
      groups.push({
        extId: contribution.extId,
        displayName: cleanLabel(contribution.displayName) || contribution.extId,
        items,
      });
    }
  }

  // Alphabetical by what the user sees, so the order does not depend on which
  // extension happened to activate first.
  return groups.sort((a, b) => a.displayName.localeCompare(b.displayName));
}

/**
 * Whether the menu needs rebuilding at all.
 *
 * `Menu.setApplicationMenu` rebuilds the whole native menu bar, and on macOS
 * that closes any menu the user has open. Comparing first means an extension
 * that re-sends the same contributions on every activation does not make the
 * menu flicker.
 */
export function menuGroupsEqual(
  a: readonly ContributedMenuGroup[],
  b: readonly ContributedMenuGroup[],
): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}
