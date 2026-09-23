/**
 * Turning an untrusted `package.json` into a manifest, or refusing to.
 *
 * The same shape `features/fx/presetValidate.ts` uses for a preset folder, and
 * for the same reasons. Everything that decides whether a folder is an
 * extension happens here, once, so an extension the app ships and an extension
 * someone downloaded go through one path: if a third party's manifest were
 * going to break, ours would break in the same place.
 *
 * A rejection is per extension and never fatal. One unreadable `package.json`
 * in `userData/extensions` must not cost the user every other extension, so
 * `validateManifest` collects errors and the loader drops that one.
 *
 * Nothing here reads the disk or imports Electron, so it runs under
 * `environment: "node"` against literals.
 */

import { z } from "zod";

import {
  COMMAND_ID_PATTERN,
  EXTENSION_API_VERSION,
  EXTENSION_ID_PATTERN,
  VIEW_ID_PATTERN,
} from "./protocol";
import { PERMISSIONS, type Permission } from "./permissions";
import { isSafeRelativePath } from "./paths";

/** Where a contributed menu item can appear. A closed list: each has a host. */
export const MENU_LOCATIONS = ["app/extensions", "timeline/clip"] as const;
export type MenuLocation = (typeof MENU_LOCATIONS)[number];

/** What kind of surface a view is mounted on. */
export const VIEW_KINDS = ["sidebar", "panel", "inspector", "overlay"] as const;
export type ViewKind = (typeof VIEW_KINDS)[number];

const relativePath = z.string().refine(isSafeRelativePath, {
  message: "must be a relative path that stays inside the extension folder",
});

const commandSchema = z.object({
  id: z.string().regex(COMMAND_ID_PATTERN),
  title: z.string().min(1).max(200),
  icon: z.string().max(64).optional(),
  /**
   * Gives the call ten minutes instead of twenty seconds.
   *
   * Opt in rather than a default, because the default is what protects the
   * user from a command that silently never returns: without it a wedged
   * handler is a spinner nobody can dismiss.
   */
  longRunning: z.boolean().optional(),
});

const keybindingSchema = z.object({
  command: z.string().regex(COMMAND_ID_PATTERN),
  key: z.string().min(1).max(64),
  when: z.string().max(200).optional(),
});

const menuItemSchema = z.object({
  command: z.string().regex(COMMAND_ID_PATTERN),
  when: z.string().max(200).optional(),
});

const viewSchema = z.object({
  id: z.string().regex(VIEW_ID_PATTERN),
  kind: z.enum(VIEW_KINDS),
  title: z.string().min(1).max(200),
  icon: z.string().max(64).optional(),
  page: relativePath,
  /** For an inspector section: which element types it belongs to. */
  elementTypes: z.array(z.string().max(32)).max(16).optional(),
});

const configPropertySchema = z.object({
  type: z.enum(["string", "number", "integer", "boolean"]),
  default: z.union([z.string(), z.number(), z.boolean()]).optional(),
  description: z.string().max(400).optional(),
  enum: z.array(z.union([z.string(), z.number()])).max(64).optional(),
  minimum: z.number().optional(),
  maximum: z.number().optional(),
});

const toolSchema = z.object({
  /**
   * snake_case, because it becomes an MCP tool name and every built-in one is.
   * A camelCase tool in the same list reads as a different product.
   */
  name: z.string().regex(/^[a-z][a-z0-9_]{0,48}$/),
  description: z.string().min(1).max(1200),
  inputSchema: z.record(z.unknown()).optional(),
});

const contributesSchema = z
  .object({
    commands: z.array(commandSchema).max(200).optional(),
    keybindings: z.array(keybindingSchema).max(200).optional(),
    menus: z.record(z.enum(MENU_LOCATIONS), z.array(menuItemSchema).max(100)).optional(),
    views: z.array(viewSchema).max(50).optional(),
    configuration: z
      .object({
        title: z.string().max(200).optional(),
        properties: z.record(z.string(), configPropertySchema).optional(),
      })
      .optional(),
    statusBar: z
      .array(
        z.object({
          id: z.string().regex(COMMAND_ID_PATTERN),
          alignment: z.enum(["left", "right"]).optional(),
          priority: z.number().int().min(0).max(1000).optional(),
        }),
      )
      .max(20)
      .optional(),
    presets: relativePath.optional(),
    templates: relativePath.optional(),
    fonts: relativePath.optional(),
    animationPresets: relativePath.optional(),
    themes: relativePath.optional(),
    tools: z.array(toolSchema).max(50).optional(),
    elementData: z.record(z.string(), z.object({ description: z.string().max(400).optional() })).optional(),
  })
  .strict();

const cartcutSectionSchema = z
  .object({
    activationEvents: z.array(z.string().min(1).max(200)).max(100).optional(),
    permissions: z.array(z.string()).max(32).optional(),
    contributes: contributesSchema.optional(),
    /** Reserved for the future Node-less host. Refused for now, not ignored. */
    isolation: z.enum(["shared"]).optional(),
  })
  .strict();

const packageSchema = z.object({
  name: z.string().min(1).max(64),
  publisher: z.string().min(1).max(64),
  version: z.string().min(1).max(32),
  displayName: z.string().max(200).optional(),
  description: z.string().max(1000).optional(),
  main: relativePath,
  engines: z.object({ cartcut: z.string().min(1).max(32) }),
  cartcut: cartcutSectionSchema,
});

export type ExtensionContributes = z.infer<typeof contributesSchema>;

export type ExtensionManifest = {
  id: string;
  name: string;
  publisher: string;
  version: string;
  displayName: string;
  description: string;
  main: string;
  engineRange: string;
  activationEvents: string[];
  permissions: Permission[];
  contributes: ExtensionContributes;
};

export type ManifestResult =
  | { ok: true; manifest: ExtensionManifest }
  | { ok: false; errors: string[] };

/**
 * Whether `EXTENSION_API_VERSION` satisfies a declared range.
 *
 * Deliberately tiny: `^1`, `^1.2`, `^1.2.3`, `>=1.2.3`, `1.x` and `*`. A full
 * semver implementation would be a dependency in the main process for one
 * comparison, and the ranges a manifest can usefully express against a single
 * host version are these. Anything it does not understand is refused rather
 * than assumed compatible, so a range this cannot read is a visible error at
 * install rather than a crash at activation.
 */
export function satisfiesEngine(range: string, version: string = EXTENSION_API_VERSION): boolean {
  const actual = parseVersion(version);
  if (actual == null) {
    return false;
  }
  const trimmed = range.trim();
  if (trimmed === "*" || trimmed === "") {
    return true;
  }

  const caret = /^\^\s*(\d+)(?:\.(\d+))?(?:\.(\d+))?$/.exec(trimmed);
  if (caret != null) {
    const major = Number(caret[1]);
    const minor = caret[2] == null ? 0 : Number(caret[2]);
    const patch = caret[3] == null ? 0 : Number(caret[3]);
    if (actual.major !== major) {
      return false;
    }
    return compare(actual, { major, minor, patch }) >= 0;
  }

  const atLeast = /^>=\s*(\d+)\.(\d+)\.(\d+)$/.exec(trimmed);
  if (atLeast != null) {
    return (
      compare(actual, {
        major: Number(atLeast[1]),
        minor: Number(atLeast[2]),
        patch: Number(atLeast[3]),
      }) >= 0
    );
  }

  const wildcard = /^(\d+)\.x(?:\.x)?$/.exec(trimmed);
  if (wildcard != null) {
    return actual.major === Number(wildcard[1]);
  }

  const exact = parseVersion(trimmed);
  if (exact != null) {
    return compare(actual, exact) === 0;
  }

  return false;
}

type Version = { major: number; minor: number; patch: number };

function parseVersion(value: string): Version | null {
  const match = /^(\d+)\.(\d+)\.(\d+)/.exec(value.trim());
  if (match == null) {
    return null;
  }
  return { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]) };
}

function compare(a: Version, b: Version): number {
  if (a.major !== b.major) {
    return a.major - b.major;
  }
  if (a.minor !== b.minor) {
    return a.minor - b.minor;
  }
  return a.patch - b.patch;
}

/**
 * The activation events this build understands.
 *
 * An unknown one is an error rather than a no-op, because a typo in
 * `onCommnad:foo` would otherwise produce an extension that installs cleanly,
 * shows its command, and does nothing when it is clicked.
 */
export function isKnownActivationEvent(value: string): boolean {
  if (value === "*" || value === "onStartup" || value === "onProjectOpen") {
    return true;
  }
  return (
    /^onCommand:[a-zA-Z][a-zA-Z0-9._-]{0,63}$/.test(value) ||
    /^onView:[a-zA-Z][a-zA-Z0-9._-]{0,63}$/.test(value) ||
    /^onFiletype:[a-z0-9]{1,12}$/.test(value)
  );
}

/**
 * Validate one `package.json`, against the folder it was found in.
 *
 * `dirName` is not decoration. The folder name is the id used in a
 * `cartcut-ext://` URL and in every path this system builds, so a manifest
 * that claims a different id than the folder it sits in is refused: otherwise
 * an extension could be installed under one id and serve its pages under
 * another, and the scheme handler's containment check would be resolving
 * against the wrong directory.
 */
export function validateManifest(json: unknown, dirName: string): ManifestResult {
  const parsed = packageSchema.safeParse(json);
  if (!parsed.success) {
    return {
      ok: false,
      errors: parsed.error.issues.map((issue) => issue.path.join(".") + ": " + issue.message),
    };
  }

  const value = parsed.data;
  const errors: string[] = [];
  const id = value.publisher.toLowerCase() + "." + value.name.toLowerCase();

  if (!EXTENSION_ID_PATTERN.test(id)) {
    errors.push(
      "publisher.name: `" + id + "` is not a valid extension id (lowercase letters, digits and dashes)",
    );
  }
  if (dirName !== "" && dirName !== id) {
    errors.push("folder `" + dirName + "` does not match the manifest id `" + id + "`");
  }
  if (parseVersion(value.version) == null) {
    errors.push("version: `" + value.version + "` is not a three-part version");
  }
  if (!satisfiesEngine(value.engines.cartcut)) {
    errors.push(
      "engines.cartcut: `" +
        value.engines.cartcut +
        "` is not satisfied by this app's extension API " +
        EXTENSION_API_VERSION,
    );
  }

  const permissions: Permission[] = [];
  for (const permission of value.cartcut.permissions ?? []) {
    if (!(PERMISSIONS as readonly string[]).includes(permission)) {
      errors.push("permissions: `" + permission + "` is not a permission this app grants");
      continue;
    }
    permissions.push(permission as Permission);
  }

  const activationEvents = value.cartcut.activationEvents ?? [];
  for (const event of activationEvents) {
    if (!isKnownActivationEvent(event)) {
      errors.push("activationEvents: `" + event + "` is not an activation event this app raises");
    }
  }

  const contributes = value.cartcut.contributes ?? {};

  const commandIds = new Set<string>();
  for (const command of contributes.commands ?? []) {
    if (commandIds.has(command.id)) {
      errors.push("contributes.commands: `" + command.id + "` is declared twice");
    }
    commandIds.add(command.id);
  }

  const viewIds = new Set<string>();
  for (const view of contributes.views ?? []) {
    if (viewIds.has(view.id)) {
      errors.push("contributes.views: `" + view.id + "` is declared twice");
    }
    viewIds.add(view.id);
  }

  // A keybinding or menu item naming a command that does not exist would be a
  // key that swallows a keystroke and does nothing, which is worse than no
  // binding at all: the app's own handler already declined it by then.
  for (const binding of contributes.keybindings ?? []) {
    if (!commandIds.has(binding.command)) {
      errors.push("contributes.keybindings: `" + binding.command + "` is not a contributed command");
    }
  }
  for (const [location, items] of Object.entries(contributes.menus ?? {})) {
    for (const item of items ?? []) {
      if (!commandIds.has(item.command)) {
        errors.push("contributes.menus." + location + ": `" + item.command + "` is not a contributed command");
      }
    }
  }
  for (const item of contributes.statusBar ?? []) {
    void item;
  }

  if ((contributes.tools ?? []).length > 0 && !permissions.includes("ai.tools")) {
    errors.push("contributes.tools needs the `ai.tools` permission");
  }

  if (errors.length > 0) {
    return { ok: false, errors };
  }

  return {
    ok: true,
    manifest: {
      id,
      name: value.name,
      publisher: value.publisher,
      version: value.version,
      displayName: value.displayName ?? value.name,
      description: value.description ?? "",
      main: value.main,
      engineRange: value.engines.cartcut,
      activationEvents,
      permissions,
      contributes,
    },
  };
}
