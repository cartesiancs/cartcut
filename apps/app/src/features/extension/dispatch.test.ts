import { describe, expect, it, vi } from "vitest";

import { READ_ONLY_COMMANDS, createDispatch, type DispatchPorts } from "./dispatch";
import { currentExtensionOwner } from "./commands";

function ports(overrides: Partial<DispatchPorts> = {}) {
  const calls: Array<{ name: string; params: unknown; owner: string | null }> = [];
  const base: DispatchPorts = {
    runCommand: (name, params) => {
      calls.push({ name, params, owner: currentExtensionOwner() });
      return { ok: true };
    },
    knownCommands: () => ["list_clips", "split_clip"],
    batchPorts: () => ({
      getDocument: () => ({ schemaVersion: 2, tracks: [], elements: {} }) as never,
      withCheckpoint: () => undefined,
      ensureUndoBaseline: () => undefined,
      isLocked: () => false,
      lockMessage: () => "locked",
      runCommand: (name, params) => {
        calls.push({ name, params, owner: currentExtensionOwner() });
        return { ok: true };
      },
    }),
    permissionsOf: () => ["timeline.write", "project.write"],
    openPanel: vi.fn(),
    closePanel: vi.fn(),
    showMessage: vi.fn(),
    setStatusItem: vi.fn(),
    startTask: vi.fn(),
    progressTask: vi.fn(),
    endTask: vi.fn(),
    projectInfo: () => ({ fps: 30 }),
    ...overrides,
  };
  return { ports: base, calls };
}

const request = (method: string, params: unknown = {}, ext = "acme.hello") => ({
  method,
  params,
  ext,
});

describe("createDispatch", () => {
  it("runs a command through the agent registry", () => {
    const { ports: p, calls } = ports();
    createDispatch(p)(request("commands.execute", { name: "list_clips", params: { limit: 5 } }));
    expect(calls).toEqual([
      { name: "list_clips", params: { limit: 5 }, owner: "acme.hello" },
    ]);
  });

  it("stamps the asking extension as the owner for the duration of the call", () => {
    // The owner is never a parameter, so one extension cannot write data under
    // another's name and a Claude Code tool call cannot write under any.
    const { ports: p, calls } = ports();
    createDispatch(p)(request("commands.execute", { name: "split_clip" }, "other.ext"));
    expect(calls[0].owner).toBe("other.ext");
    expect(currentExtensionOwner()).toBeNull();
  });

  it("refuses a mutating command without timeline.write", () => {
    const { ports: p } = ports({ permissionsOf: () => [] });
    expect(() => createDispatch(p)(request("commands.execute", { name: "split_clip" }))).toThrow(
      /timeline.write/,
    );
  });

  it("lets a read through with no permission at all", () => {
    // An extension that can only look cannot damage anything, and making it
    // ask would train users to grant write to everything.
    const { ports: p, calls } = ports({ permissionsOf: () => [] });
    createDispatch(p)(request("commands.execute", { name: "list_clips" }));
    expect(calls).toHaveLength(1);
  });

  it("treats an unlisted command as mutating", () => {
    // Fail closed: a command added later is assumed to change the timeline
    // until somebody decides otherwise.
    const { ports: p } = ports({ permissionsOf: () => [] });
    expect(() =>
      createDispatch(p)(request("commands.execute", { name: "some_future_command" })),
    ).toThrow(/timeline.write/);
  });

  it("refuses a non-transactional command inside a batch", () => {
    const { ports: p } = ports();
    expect(() =>
      createDispatch(p)(request("commands.batch", { steps: [{ name: "undo" }] })),
    ).toThrow(/cannot run inside a batch/);
  });

  it("gates every step of a batch, not just the first", () => {
    const { ports: p } = ports({ permissionsOf: () => [] });
    expect(() =>
      createDispatch(p)(
        request("commands.batch", { steps: [{ name: "list_clips" }, { name: "split_clip" }] }),
      ),
    ).toThrow(/timeline.write/);
  });

  it("refuses project.setData without project.write", () => {
    const { ports: p } = ports({ permissionsOf: () => ["timeline.write"] });
    expect(() => createDispatch(p)(request("project.setData", { value: 1 }))).toThrow(
      /project.write/,
    );
  });

  it("refuses a method it does not answer", () => {
    const { ports: p } = ports();
    expect(() => createDispatch(p)(request("fs.readFile", { path: "/etc/passwd" }))).toThrow(
      /does not answer/,
    );
  });

  it("refuses a request with no extension id", () => {
    const { ports: p } = ports();
    expect(() =>
      createDispatch(p)({ method: "commands.execute", params: { name: "list_clips" } }),
    ).toThrow(/no extension id/);
  });

  it("caps the text of a message rather than refusing it", () => {
    const shown: string[] = [];
    const { ports: p } = ports({ showMessage: (text) => shown.push(text) });
    createDispatch(p)(request("window.showMessage", { text: "x".repeat(5000) }));
    expect(shown[0].length).toBe(500);
  });

  it("answers commands.list without a permission", () => {
    const { ports: p } = ports({ permissionsOf: () => [] });
    expect(createDispatch(p)({ method: "commands.list", params: {} })).toEqual({
      commands: ["list_clips", "split_clip"],
    });
  });
});

describe("READ_ONLY_COMMANDS", () => {
  it("names only commands that read", () => {
    for (const name of READ_ONLY_COMMANDS) {
      expect([name, name.startsWith("get_") || name.startsWith("list_") || name.endsWith("_info") || name === "ping" || name.startsWith("ext_get_") || name === "project_info"]).toEqual([name, true]);
    }
  });
});
