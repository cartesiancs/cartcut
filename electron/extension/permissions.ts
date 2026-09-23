/**
 * What an extension is allowed to ask for, and what that gates.
 *
 * Read the honest version first, because the name invites the wrong
 * assumption: **this is not a sandbox.** The extension host is a
 * `utilityProcess`, which is a Node environment, and Node cannot be taken away
 * from it. An extension that wants the filesystem can `require("fs")` whatever
 * its manifest says. `node:vm` would not change that; it is not a security
 * boundary and is deliberately not used anywhere here.
 *
 * What this table really does is two things worth having:
 *
 * - **Disclosure.** The install dialog lists these in the user's words before
 *   anything is extracted, which is the point at which a person can decline.
 * - **API gating.** The sanctioned paths refuse without the permission, in
 *   three places that are not the same place: the host's own `api.ts` before
 *   it touches Node, main's `services.ts` using the manifest *main* validated
 *   rather than one the host sent, and the renderer for anything that would
 *   edit the timeline. So a bug in the host cannot quietly widen what main
 *   does on its behalf.
 *
 * The wall that actually protects the app is the process boundary: the host
 * has no DOM, no store, no `electronAPI`, and can only speak the protocol. A
 * Node-less host, where these would be real, is a later tier.
 */

export const PERMISSIONS = [
  "timeline.write",
  "project.write",
  "fs.read",
  "fs.write",
  "process.spawn",
  "net",
  "clipboard",
  "shell.open",
  "secrets",
  "ai.tools",
] as const;

export type Permission = (typeof PERMISSIONS)[number];

/**
 * The sentence shown at install time.
 *
 * Written for someone deciding whether to trust a stranger, so each says what
 * the extension can reach rather than which API it unlocks. "Read files you
 * open for it" is a fact about the user's disk; "enables cartcut.fs.readFile"
 * is a fact about our code, and nobody can weigh that.
 */
const DESCRIPTIONS: Record<Permission, string> = {
  "timeline.write": "Change your timeline. Every change is one undo step.",
  "project.write": "Store its own data in your project file.",
  "fs.read": "Read files in your project folder and folders you pick for it.",
  "fs.write": "Write files in your project folder and folders you pick for it.",
  "process.spawn": "Run programs on your computer, including the bundled FFmpeg.",
  net: "Connect to the internet.",
  clipboard: "Read and write your clipboard.",
  "shell.open": "Open links and files in other apps.",
  secrets: "Store passwords and API keys in your system keychain.",
  "ai.tools": "Offer tools to Claude Code when it edits this project.",
};

export function describePermission(permission: Permission): string {
  return DESCRIPTIONS[permission];
}

export function isPermission(value: string): value is Permission {
  return (PERMISSIONS as readonly string[]).includes(value);
}

/** Whether a manifest declared this permission. The only reader is a gate. */
export function hasPermission(
  granted: readonly Permission[] | undefined,
  permission: Permission,
): boolean {
  return granted != null && granted.includes(permission);
}

/**
 * The permission each protocol method needs, or absent for none.
 *
 * A table rather than a check at each call site, so that adding a method
 * without deciding what it costs is a visible omission in one file.
 * Read-only timeline access is deliberately free: an extension that can only
 * look cannot damage anything, and making it ask would train users to grant
 * write to everything.
 */
export const METHOD_PERMISSIONS: Record<string, Permission> = {
  "commands.batch": "timeline.write",
  "project.setData": "project.write",
  "window.showOpenDialog": "fs.read",
  "window.showSaveDialog": "fs.write",
  "assets.reveal": "shell.open",
  "shell.open": "shell.open",
  "paths.ffmpeg": "process.spawn",
  "paths.ffprobe": "process.spawn",
  "secrets.get": "secrets",
  "secrets.set": "secrets",
  "secrets.delete": "secrets",
  "ai.registerTool": "ai.tools",
  "ai.unregisterTool": "ai.tools",
};
