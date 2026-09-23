/**
 * One extension's life, and what wakes it up.
 *
 * Split from the loader so the orderings can be tested without loading
 * anybody's code: an `activate` that throws, an `activate` that never
 * resolves, a deactivate that runs while an activation is still in flight.
 * Each of those is a real failure of a real extension, and each has a case in
 * the suite instead of a comment here.
 */

export type ExtensionPhase =
  | "discovered"
  | "validated"
  | "activating"
  | "active"
  | "deactivating"
  | "failed";

export type ExtensionRecord = {
  id: string;
  phase: ExtensionPhase;
  /** The reason it failed, shown in the Extensions panel. */
  error: string | null;
  /** Which activation event woke it, for the log. */
  activatedBy: string | null;
  enabled: boolean;
};

export type ExtensionEvent =
  | { type: "validated" }
  | { type: "invalid"; error: string }
  | { type: "activate"; trigger: string }
  | { type: "activated" }
  | { type: "activationFailed"; error: string }
  | { type: "deactivate" }
  | { type: "deactivated" }
  | { type: "setEnabled"; enabled: boolean };

export function initialExtension(id: string, enabled: boolean = true): ExtensionRecord {
  return { id, phase: "discovered", error: null, activatedBy: null, enabled };
}

export function reduceExtension(record: ExtensionRecord, event: ExtensionEvent): ExtensionRecord {
  switch (event.type) {
    case "validated":
      return record.phase === "discovered" ? { ...record, phase: "validated", error: null } : record;

    case "invalid":
      return { ...record, phase: "failed", error: event.error };

    case "activate": {
      // A second trigger while the first activation is still running must not
      // start a second `activate()`. The loader queues the pending invoke
      // behind the one in flight instead, which is why this declines by
      // identity rather than restarting the phase.
      if (record.phase !== "validated" || !record.enabled) {
        return record;
      }
      return { ...record, phase: "activating", activatedBy: event.trigger };
    }

    case "activated":
      return record.phase === "activating" ? { ...record, phase: "active", error: null } : record;

    case "activationFailed":
      return record.phase === "activating"
        ? { ...record, phase: "failed", error: event.error }
        : record;

    case "deactivate":
      // From `activating` too: a disable pressed while activation hangs has to
      // land, or the only way out of a wedged activate is restarting the host.
      return record.phase === "active" || record.phase === "activating"
        ? { ...record, phase: "deactivating" }
        : record;

    case "deactivated":
      return record.phase === "deactivating"
        ? { ...record, phase: "validated", activatedBy: null }
        : record;

    case "setEnabled": {
      if (record.enabled === event.enabled) {
        return record;
      }
      return { ...record, enabled: event.enabled };
    }

    default:
      return record;
  }
}

/** What happened that might wake an extension. */
export type ActivationTrigger =
  | { kind: "startup" }
  | { kind: "projectOpen" }
  | { kind: "command"; id: string }
  | { kind: "view"; id: string }
  | { kind: "filetype"; ext: string };

/** The declared event string a trigger corresponds to. */
export function activationEventFor(trigger: ActivationTrigger): string {
  switch (trigger.kind) {
    case "startup":
      return "onStartup";
    case "projectOpen":
      return "onProjectOpen";
    case "command":
      return "onCommand:" + trigger.id;
    case "view":
      return "onView:" + trigger.id;
    case "filetype":
      return "onFiletype:" + trigger.ext;
  }
}

/**
 * Whether a manifest's activation events cover this trigger.
 *
 * `"*"` matches everything, and is what a development extension uses while its
 * author works out which events it needs. It is not the default: an extension
 * that declares nothing never activates, which is a loud failure rather than
 * the quiet cost of every extension loading at startup.
 */
export function matchesActivation(
  declared: readonly string[],
  trigger: ActivationTrigger,
): boolean {
  if (declared.includes("*")) {
    return true;
  }
  return declared.includes(activationEventFor(trigger));
}
