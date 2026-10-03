/**
 * What the Extensions panel draws for each installed extension, decided away
 * from the Lit class so a suite can check it.
 *
 * `Listing` is the shape main's `ext:list` answers with; nothing here asks
 * main anything.
 */

export type Listing = {
  id: string;
  dir: string;
  origin: "installed" | "unpacked";
  displayName: string;
  version: string;
  description: string;
  permissions: string[];
  enabled: boolean;
  phase: string;
  errors: string[];
  configuration: { title?: string; properties?: Record<string, ConfigProperty> } | null;
};

export type ConfigProperty = {
  type: "string" | "number" | "integer" | "boolean";
  default?: string | number | boolean;
  description?: string;
  enum?: Array<string | number>;
  minimum?: number;
  maximum?: number;
};

/** The dot beside an extension's name. */
export type ListingStatus = "off" | "failed" | "starting" | "active" | "idle";

export function listingStatus(listing: Pick<Listing, "enabled" | "phase">): ListingStatus {
  if (!listing.enabled) {
    return "off";
  }
  if (listing.phase === "failed") {
    return "failed";
  }
  if (listing.phase === "activating") {
    return "starting";
  }
  if (listing.phase === "active") {
    return "active";
  }
  return "idle";
}

export const STATUS_LABELS: Record<ListingStatus, string> = {
  off: "Off",
  failed: "Failed",
  starting: "Starting",
  active: "Active",
  idle: "Idle",
};

/**
 * A setting's row label, from its key: `hello.greeting` is "Greeting".
 *
 * The key rather than the manifest's `description`, because a description is
 * written as a sentence ("What the title says") and a row label has about
 * ninety pixels. The description becomes the row's tooltip.
 */
export function settingLabel(key: string): string {
  const leaf = key.slice(key.lastIndexOf(".") + 1);
  const words = leaf
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .split(/[\s_-]+/)
    .filter((word) => word !== "");
  if (words.length === 0) {
    return key;
  }
  return words
    .map((word, index) => {
      // An acronym stays as written: "maxFPS" is "Max FPS", not "Max fps".
      if (word.length > 1 && word === word.toUpperCase()) {
        return word;
      }
      const lower = word.toLowerCase();
      return index === 0 ? lower.charAt(0).toUpperCase() + lower.slice(1) : lower;
    })
    .join(" ");
}

/**
 * Each permission as a glyph and a word, for the chips in an extension's
 * details. A hand copy of `electron/extension/permissions.ts#PERMISSIONS`,
 * pinned by `listing.test.ts`: the renderer does not reach into `electron/`
 * outside `shared.ts`, and these words are the panel's, not the install
 * dialog's sentences.
 */
export const PERMISSION_CHIPS: Record<string, { icon: string; label: string }> = {
  "timeline.write": { icon: "movie_edit", label: "Timeline" },
  "project.write": { icon: "save", label: "Project" },
  "fs.read": { icon: "folder_open", label: "Read files" },
  "fs.write": { icon: "edit_document", label: "Write files" },
  "process.spawn": { icon: "terminal", label: "Programs" },
  net: { icon: "language", label: "Internet" },
  clipboard: { icon: "content_paste", label: "Clipboard" },
  "shell.open": { icon: "open_in_new", label: "Open links" },
  secrets: { icon: "key", label: "Keychain" },
  "ai.tools": { icon: "smart_toy", label: "Claude" },
};

/** An unknown id still draws, as itself, rather than vanishing from the list. */
export function permissionChip(permission: string): { icon: string; label: string } {
  return PERMISSION_CHIPS[permission] ?? { icon: "shield", label: permission };
}

/** Whether the panel's search keeps a line. An empty query keeps everything. */
export function matchesQuery(query: string, ...fields: string[]): boolean {
  const needle = query.trim().toLowerCase();
  return needle === "" || fields.some((field) => field.toLowerCase().includes(needle));
}
