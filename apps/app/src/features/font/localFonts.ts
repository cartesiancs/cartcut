/**
 * The fonts installed on the machine a browser build runs on.
 *
 * The desktop app lists them from main (`electron/lib/font.ts` walks the font
 * folders). A page cannot walk a folder, so a browser build asks Chrome's Local
 * Font Access API, `window.queryLocalFonts()`, which answers one record per
 * face after the user grants the `local-fonts` permission. The browser keeps
 * that grant per origin, so nothing here is persisted.
 *
 * A face from this list is stored as `fontpath: "local:<postscriptName>"` and
 * drawn through `@font-face { src: local(...) }` (`fontFaces.ts`). That needs
 * no permission at all: only *listing* the fonts does, so a project that
 * already uses one draws before anybody has been asked anything.
 *
 * Three rules the API imposes, and where each is kept:
 *  - It exists only in Chrome and Edge on a desktop, and only in a secure
 *    context (https, or localhost). `unsupportedReason`.
 *  - The spec asks for a user gesture on every call. So `requestLocalFonts`
 *    calls `query` before anything else it does, and the silent restore at
 *    startup treats a `SecurityError` as "ask with a button", not as a failure.
 *  - `family` and `style` come from the font's name table in the user's
 *    language when one exists, so a style such as "볼드" is possible.
 *    `localFaceOf` falls back to the postscript name's suffix for those.
 *
 * DOM-free: the browser is reached through `LocalFontPort`, so every decision
 * here runs under `environment: "node"` against a fake.
 */

import { createStore, type StoreApi } from "zustand/vanilla";
import { LOCAL_FONT_TYPE, localFontPath, type FontEntry } from "./fontFaces";
import { DEFAULT_FONT_WEIGHT, parseStyleName } from "./fontWeight";

/** The little of `FontData` this module reads. */
export type FontDataLike = {
  postscriptName: string;
  family: string;
  style: string;
  fullName?: string;
};

export type LocalFontPermission = "granted" | "prompt" | "denied" | "unknown";

export type LocalFontPort = {
  /** Whether `queryLocalFonts` exists at all. */
  available(): boolean;
  /** Whether the page is a secure context, which the API requires. */
  secure(): boolean;
  /** The `local-fonts` permission's state, without asking for it. */
  permission(): Promise<LocalFontPermission>;
  /** `queryLocalFonts()`. Called synchronously by whoever wants the list. */
  query(): Promise<FontDataLike[]>;
};

/**
 * The real browser, looked up on every call rather than at import, so this
 * module loads under node and in a build where the API is missing.
 */
export function browserLocalFontPort(): LocalFontPort {
  const scope = globalThis as any;
  return {
    available: () => typeof scope.queryLocalFonts === "function",
    secure: () => scope.isSecureContext !== false,
    permission: async () => {
      try {
        const status = await scope.navigator?.permissions?.query?.({
          name: "local-fonts",
        });
        const state = status?.state;
        return state === "granted" || state === "prompt" || state === "denied"
          ? state
          : "unknown";
      } catch {
        // A browser that has the API but not this permission name in the
        // Permissions API: "unknown" means "offer the button".
        return "unknown";
      }
    },
    query: () => scope.queryLocalFonts(),
  };
}

// -------------------------------------------------------------- the entries

/**
 * Characters a postscript name may not carry here.
 *
 * `renderer/text.ts` splices `"${fontname}"` into `ctx.font` without escaping,
 * so a quote or a backslash would end the family early; a control character
 * makes the whole font string invalid, which the canvas ignores silently. The
 * PostScript spec forbids all of them anyway, so a name holding one is junk.
 */
const UNSAFE_NAME = /["\\\u0000-\u001f\u007f]/;

/** The PostScript name limit. Longer is not a real font. */
const MAX_NAME_LENGTH = 127;

function isUsableName(name: unknown): name is string {
  return (
    typeof name === "string" &&
    name !== "" &&
    name.length <= MAX_NAME_LENGTH &&
    !UNSAFE_NAME.test(name) &&
    // macOS lists private system faces under names such as ".SFNS-Regular".
    // They are not meant to be chosen and some refuse to load by name.
    !name.startsWith(".")
  );
}

const ASCII = /^[ -~]*$/;

/**
 * Where a face sits in its family.
 *
 * The family is taken as the browser gives it and only the style is read
 * (`parseStyleName`). Words of the style it cannot read, a width like
 * "Condensed", are added to the family, which keeps "Helvetica Neue Condensed"
 * apart from "Helvetica Neue" the way a desktop file name would. A style that
 * is not ASCII is in the user's language, and the postscript name's suffix
 * ("NotoSansKR-Bold") says the same thing in English; with no suffix to read,
 * the style is kept whole so the face stays reachable as a family of its own
 * rather than colliding with the regular one. `null` when there is no family.
 */
export function localFaceOf(
  data: FontDataLike,
): { family: string; weight: number; italic: boolean } | null {
  const family = typeof data?.family === "string" ? data.family.trim() : "";
  if (family === "") {
    return null;
  }

  const style = typeof data.style === "string" ? data.style.trim() : "";
  let read = parseStyleName(style);

  if (!ASCII.test(style)) {
    const name = data.postscriptName;
    const dash = name.lastIndexOf("-");
    read =
      dash > 0
        ? parseStyleName(name.slice(dash + 1))
        : { weight: DEFAULT_FONT_WEIGHT, italic: false, rest: style };
  }

  return {
    family: read.rest === "" ? family : `${family} ${read.rest}`,
    weight: read.weight,
    italic: read.italic,
  };
}

/**
 * The browser's list as font entries: usable names only, each once, in a
 * stable order.
 *
 * The same font installed twice (a user copy and a system copy) is common and
 * is listed twice; the first is kept. A family starting with "." is a private
 * system face for the same reason as the names.
 */
export function localFontEntries(list: readonly FontDataLike[]): FontEntry[] {
  const seen = new Set<string>();
  const entries: FontEntry[] = [];

  for (const data of list ?? []) {
    const name = data?.postscriptName;
    if (!isUsableName(name) || seen.has(name)) {
      continue;
    }
    if (typeof data.family === "string" && data.family.startsWith(".")) {
      continue;
    }
    seen.add(name);

    const face = localFaceOf(data);
    const label =
      typeof data.fullName === "string" && data.fullName.trim() !== ""
        ? data.fullName.trim()
        : name;

    entries.push({
      path: localFontPath(name),
      name,
      type: LOCAL_FONT_TYPE,
      ...(face == null ? {} : { face }),
      label,
    });
  }

  return entries.sort(
    (a, b) =>
      (a.label ?? a.name).localeCompare(b.label ?? b.name) ||
      (a.name < b.name ? -1 : a.name > b.name ? 1 : 0),
  );
}

// ----------------------------------------------------------------- the store

export type LocalFontStatus =
  /** Not asked yet: the restore has not answered. */
  | "idle"
  /** No API, or not a secure context; see `reason`. */
  | "unsupported"
  /** The list needs a click: no grant yet, or the browser wants a gesture. */
  | "needs-permission"
  | "loading"
  | "ready"
  /** The user, or the site settings, said no. */
  | "denied"
  /** A permissions policy forbids it, such as a cross-origin iframe. */
  | "blocked"
  | "error";

export type LocalFontState = {
  status: LocalFontStatus;
  reason: "no-api" | "insecure" | null;
  permission: LocalFontPermission;
  fonts: FontEntry[];
};

export function createLocalFontStore(): StoreApi<LocalFontState> {
  return createStore<LocalFontState>(() => ({
    status: "idle",
    reason: null,
    permission: "unknown",
    fonts: [],
  }));
}

/** The app's one list. Tests make their own with `createLocalFontStore`. */
export const localFontStore = createLocalFontStore();

/** Write only what changed: a set that changes nothing still wakes every subscriber. */
function patch(store: StoreApi<LocalFontState>, next: Partial<LocalFontState>): void {
  const current = store.getState();
  const changed = (Object.keys(next) as (keyof LocalFontState)[]).some(
    (key) => current[key] !== next[key],
  );
  if (changed) {
    store.setState(next);
  }
}

function unsupportedReason(port: LocalFontPort): "no-api" | "insecure" | null {
  // Secure first: Chrome hides the API on plain http, so a missing function
  // there means "use https", not "use another browser".
  if (!port.secure()) {
    return "insecure";
  }
  return port.available() ? null : "no-api";
}

/**
 * What a rejection means.
 *
 * A `SecurityError` is a missing gesture or a permissions policy. On the
 * silent restore it can only be the gesture, so the button is the answer; on a
 * click there was a gesture, so it is the policy and there is nothing to retry.
 */
export function statusForError(
  error: unknown,
  interactive: boolean,
): LocalFontStatus {
  const name = (error as { name?: unknown } | null)?.name;
  if (name === "NotAllowedError") {
    return "denied";
  }
  if (name === "SecurityError") {
    return interactive ? "blocked" : "needs-permission";
  }
  return "error";
}

/** The query in flight per store, which a restore and a click share. */
const pending = new WeakMap<StoreApi<LocalFontState>, Promise<void>>();

/**
 * Start the query now, synchronously, and settle the store when it answers.
 * Joins one already running rather than asking twice.
 */
function load(
  port: LocalFontPort,
  store: StoreApi<LocalFontState>,
  interactive: boolean,
): Promise<void> {
  const running = pending.get(store);
  if (running != null) {
    return running;
  }

  let query: Promise<FontDataLike[]>;
  try {
    query = Promise.resolve(port.query());
  } catch (error) {
    query = Promise.reject(error);
  }

  patch(store, { status: "loading", reason: null });

  const settled = query.then(
    async (list) => {
      const fonts = localFontEntries(Array.isArray(list) ? list : []);
      // Chrome answers a prompt that was dismissed, or one it could not show,
      // with an empty list rather than a rejection (measured in headless
      // Chrome, which shows no prompt). So an empty answer asks the permission
      // what it meant: refused, or not given yet, which offers the button again.
      if (fonts.length === 0) {
        const permission = await port.permission();
        if (permission !== "granted") {
          patch(store, {
            status: permission === "denied" ? "denied" : "needs-permission",
            permission,
          });
          return;
        }
      }
      patch(store, { status: "ready", permission: "granted", fonts });
    },
    (error) => {
      const status = statusForError(error, interactive);
      patch(store, {
        status,
        ...(status === "denied" ? { permission: "denied" as const } : {}),
      });
    },
  );
  const tracked = settled.finally(() => {
    if (pending.get(store) === tracked) {
      pending.delete(store);
    }
  });
  pending.set(store, tracked);
  return tracked;
}

/**
 * At startup: load the list without asking when the permission is already
 * granted, and otherwise only say what the menu should offer.
 *
 * Never calls `query` unless the permission is granted, because without a
 * grant that call would be a prompt nobody clicked for.
 */
export function restoreLocalFonts(
  port: LocalFontPort = browserLocalFontPort(),
  store: StoreApi<LocalFontState> = localFontStore,
): Promise<void> {
  const reason = unsupportedReason(port);
  if (reason != null) {
    patch(store, { status: "unsupported", reason });
    return Promise.resolve();
  }

  return port.permission().then((permission) => {
    // A click may have started the query while the permission was being read.
    const running = pending.get(store);
    if (running != null) {
      return running;
    }
    if (permission === "granted") {
      patch(store, { permission });
      return load(port, store, false);
    }
    patch(store, {
      permission,
      status: permission === "denied" ? "denied" : "needs-permission",
    });
  });
}

/**
 * From a click: ask for the list, with the gesture the click carries.
 *
 * `query` is the first thing that happens. The checks before it are
 * synchronous and so cost the gesture nothing, which is not true of anything
 * awaited.
 */
export function requestLocalFonts(
  port: LocalFontPort = browserLocalFontPort(),
  store: StoreApi<LocalFontState> = localFontStore,
): Promise<void> {
  const reason = unsupportedReason(port);
  if (reason != null) {
    patch(store, { status: "unsupported", reason });
    return Promise.resolve();
  }
  return load(port, store, true);
}

// ---------------------------------------------------------------- the notice

export type LocalFontNotice = {
  message: string | null;
  action: { kind: "request" | "retry"; label: string } | null;
};

/**
 * What the font menu says about the list, or `null` for nothing.
 *
 * A table rather than markup so every state is checked here; the menu only
 * draws it.
 */
export function localFontNotice(
  state: Pick<LocalFontState, "status" | "reason" | "fonts">,
): LocalFontNotice | null {
  switch (state.status) {
    case "idle":
      return null;
    case "ready":
      return state.fonts.length > 0
        ? null
        : { message: "The browser listed no fonts on this computer.", action: null };
    case "unsupported":
      return {
        message:
          state.reason === "insecure"
            ? "Fonts on this computer need an https connection."
            : "Fonts on this computer need Chrome or Edge on a desktop.",
        action: null,
      };
    case "needs-permission":
      return {
        message: "The browser asks for permission once.",
        action: { kind: "request", label: "Use fonts on this computer" },
      };
    case "loading":
      return { message: "Loading fonts on this computer...", action: null };
    case "denied":
      return {
        message:
          "Font access is blocked. Allow Fonts for this site in the browser's site settings.",
        action: { kind: "retry", label: "Try again" },
      };
    case "blocked":
      return { message: "This page is not allowed to read local fonts.", action: null };
    case "error":
      return {
        message: "Could not read the fonts on this computer.",
        action: { kind: "retry", label: "Try again" },
      };
  }
}
