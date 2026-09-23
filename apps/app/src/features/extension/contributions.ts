/**
 * What the loaded extensions have contributed, as one store the UI reads.
 *
 * A vanilla zustand store in the shape `features/window/windowStore.ts` uses,
 * including its rule: **every action returns `state` itself when nothing
 * changed.** zustand compares with `Object.is`, so returning a fresh object
 * for a write that changed nothing wakes every subscriber. That is not
 * theoretical here either, because the host re-sends its whole hello on every
 * restart and a developer reloading an unpacked extension does that every time
 * they save.
 *
 * It holds only what the app draws. An extension's code, its permissions and
 * its process are the host's business; this is the list of tabs, panels,
 * commands, keybindings, menu items and status items the editor has to render,
 * already flattened and already namespaced by extension id so two extensions
 * cannot collide.
 */

import { createStore } from "zustand/vanilla";

import type { HelloExtension } from "./shared";

export type ViewKind = "sidebar" | "panel" | "inspector" | "overlay";

export type ContributedView = {
  /** `<extId>/<viewId>`, unique across every extension. */
  key: string;
  extId: string;
  viewId: string;
  kind: ViewKind;
  title: string;
  icon: string | null;
  /** The page, relative to the extension folder. Already path-checked by main. */
  page: string;
  elementTypes: string[];
};

export type ContributedCommand = {
  key: string;
  extId: string;
  commandId: string;
  title: string;
  icon: string | null;
  longRunning: boolean;
};

export type ContributedKeybinding = {
  extId: string;
  commandId: string;
  key: string;
  when: string | null;
};

export type ContributedMenuItem = {
  extId: string;
  commandId: string;
  title: string;
  when: string | null;
  location: string;
};

export type ContributedStatusItem = {
  key: string;
  extId: string;
  itemId: string;
  alignment: "left" | "right";
  priority: number;
  /** Set at run time by `window.setStatusItem`, not by the manifest. */
  text: string;
  tooltip: string | null;
  commandId: string | null;
};

export type LoadedExtension = {
  id: string;
  version: string;
  displayName: string;
  permissions: string[];
};

export interface IContributionStore {
  extensions: LoadedExtension[];
  views: ContributedView[];
  commands: ContributedCommand[];
  keybindings: ContributedKeybinding[];
  menus: ContributedMenuItem[];
  statusItems: ContributedStatusItem[];

  /** Replace everything, from one host hello. */
  applyHello: (extensions: readonly HelloExtension[]) => void;
  /** Drop one extension's contributions, for a disable or a crash. */
  removeExtension: (extId: string) => void;
  /** Drop everything, for a host that went away. */
  clear: () => void;
  setStatusItem: (item: ContributedStatusItem | { extId: string; itemId: string; remove: true }) => void;
}

const EMPTY: Omit<IContributionStore, "applyHello" | "removeExtension" | "clear" | "setStatusItem"> = {
  extensions: [],
  views: [],
  commands: [],
  keybindings: [],
  menus: [],
  statusItems: [],
};

function str(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function list(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

/**
 * Flatten one hello into the six lists the UI reads.
 *
 * Every field is read defensively even though main validated the manifest,
 * for the reason `normalizeX` guards reads: this runs on a message from
 * another process, it runs before anything is drawn, and a `undefined.map`
 * here would take the editor's first paint with it. Main's validation is what
 * makes a bad manifest a visible error; this is what makes it survivable.
 */
export function flattenContributions(extensions: readonly HelloExtension[]) {
  const next = {
    extensions: [] as LoadedExtension[],
    views: [] as ContributedView[],
    commands: [] as ContributedCommand[],
    keybindings: [] as ContributedKeybinding[],
    menus: [] as ContributedMenuItem[],
  };

  for (const extension of extensions) {
    const extId = str(extension?.id);
    if (extId === "") {
      continue;
    }
    next.extensions.push({
      id: extId,
      version: str(extension.version),
      displayName: str(extension.displayName, extId),
      permissions: list(extension.permissions).map((value) => str(value)),
    });

    const contributes = (extension.contributes ?? {}) as Record<string, unknown>;

    for (const raw of list(contributes.views)) {
      const view = raw as Record<string, unknown>;
      const viewId = str(view.id);
      if (viewId === "") {
        continue;
      }
      next.views.push({
        key: extId + "/" + viewId,
        extId,
        viewId,
        kind: (str(view.kind, "panel") as ViewKind),
        title: str(view.title, viewId),
        icon: view.icon == null ? null : str(view.icon),
        page: str(view.page),
        elementTypes: list(view.elementTypes).map((value) => str(value)),
      });
    }

    for (const raw of list(contributes.commands)) {
      const command = raw as Record<string, unknown>;
      const commandId = str(command.id);
      if (commandId === "") {
        continue;
      }
      next.commands.push({
        key: extId + "/" + commandId,
        extId,
        commandId,
        title: str(command.title, commandId),
        icon: command.icon == null ? null : str(command.icon),
        longRunning: command.longRunning === true,
      });
    }

    for (const raw of list(contributes.keybindings)) {
      const binding = raw as Record<string, unknown>;
      const commandId = str(binding.command);
      const key = str(binding.key);
      if (commandId === "" || key === "") {
        continue;
      }
      next.keybindings.push({
        extId,
        commandId,
        key,
        when: binding.when == null ? null : str(binding.when),
      });
    }

    const menus = (contributes.menus ?? {}) as Record<string, unknown>;
    for (const [location, items] of Object.entries(menus)) {
      for (const raw of list(items)) {
        const item = raw as Record<string, unknown>;
        const commandId = str(item.command);
        if (commandId === "") {
          continue;
        }
        const title =
          next.commands.find((entry) => entry.extId === extId && entry.commandId === commandId)?.title ??
          commandId;
        next.menus.push({
          extId,
          commandId,
          title,
          when: item.when == null ? null : str(item.when),
          location,
        });
      }
    }
  }

  return next;
}

export const contributionStore = createStore<IContributionStore>((set) => ({
  ...EMPTY,

  applyHello: (extensions) =>
    set((state) => {
      const next = flattenContributions(extensions);
      // The host re-sends its whole hello on every restart, and a developer
      // saving an unpacked extension restarts it on every keystroke burst.
      // Without this compare, each of those would re-render every panel.
      if (
        JSON.stringify(next.extensions) === JSON.stringify(state.extensions) &&
        JSON.stringify(next.views) === JSON.stringify(state.views) &&
        JSON.stringify(next.commands) === JSON.stringify(state.commands) &&
        JSON.stringify(next.keybindings) === JSON.stringify(state.keybindings) &&
        JSON.stringify(next.menus) === JSON.stringify(state.menus)
      ) {
        return state;
      }
      return {
        ...state,
        ...next,
        // Status items are run-time state, not manifest state. An extension
        // that is still loaded keeps the row it set; one that is gone loses it.
        statusItems: state.statusItems.filter((item) =>
          next.extensions.some((entry) => entry.id === item.extId),
        ),
      };
    }),

  removeExtension: (extId) =>
    set((state) => {
      if (!state.extensions.some((entry) => entry.id === extId)) {
        return state;
      }
      const without = <T extends { extId: string }>(items: T[]) =>
        items.filter((item) => item.extId !== extId);
      return {
        ...state,
        extensions: state.extensions.filter((entry) => entry.id !== extId),
        views: without(state.views),
        commands: without(state.commands),
        keybindings: without(state.keybindings),
        menus: without(state.menus),
        statusItems: without(state.statusItems),
      };
    }),

  clear: () =>
    set((state) => {
      if (state.extensions.length === 0 && state.statusItems.length === 0) {
        return state;
      }
      return { ...state, ...EMPTY };
    }),

  setStatusItem: (item) =>
    set((state) => {
      const key = item.extId + "/" + item.itemId;
      const rest = state.statusItems.filter((existing) => existing.key !== key);

      if ("remove" in item) {
        return rest.length === state.statusItems.length ? state : { ...state, statusItems: rest };
      }

      const next = [...rest, { ...item, key }].sort(
        (a, b) => b.priority - a.priority || a.key.localeCompare(b.key),
      );
      return { ...state, statusItems: next };
    }),
}));

/** Sidebar tabs, in a stable order so they do not shuffle between launches. */
export function sidebarViews(state: IContributionStore): ContributedView[] {
  return state.views.filter((view) => view.kind === "sidebar").sort((a, b) => a.key.localeCompare(b.key));
}

export function panelViews(state: IContributionStore): ContributedView[] {
  return state.views.filter((view) => view.kind === "panel").sort((a, b) => a.key.localeCompare(b.key));
}

/** Inspector sections that belong to the selected element's type. */
export function inspectorViews(state: IContributionStore, filetype: string | null): ContributedView[] {
  return state.views.filter(
    (view) =>
      view.kind === "inspector" &&
      (view.elementTypes.length === 0 || (filetype != null && view.elementTypes.includes(filetype))),
  );
}

export function viewByKey(state: IContributionStore, key: string): ContributedView | null {
  return state.views.find((view) => view.key === key) ?? null;
}

export function commandByKey(state: IContributionStore, extId: string, commandId: string) {
  return state.commands.find((entry) => entry.extId === extId && entry.commandId === commandId) ?? null;
}
