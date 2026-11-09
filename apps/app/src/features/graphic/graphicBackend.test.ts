import { describe, expect, it } from "vitest";
import { createBackendDecision, NO_QUIRKS, type SnapshotQuirks } from "./graphicBackend";
import { GraphicHost } from "./graphicHost";
import type { ApplyState, HtmlRasterPort, MountSpec } from "./htmlRasterPort";

function ports(html: boolean | Error, snapshot: SnapshotQuirks | null | Error) {
  const asked: string[] = [];
  return {
    asked,
    ports: {
      htmlInCanvas: () => {
        asked.push("html");
        return html instanceof Error ? Promise.reject(html) : Promise.resolve(html);
      },
      snapshot: () => {
        asked.push("snapshot");
        return snapshot instanceof Error ? Promise.reject(snapshot) : Promise.resolve(snapshot);
      },
    },
  };
}

const WEBKIT: SnapshotQuirks = { ...NO_QUIRKS, shadowYFlipped: true, backfaceIgnored: true };

describe("createBackendDecision", () => {
  it("takes html-in-canvas where it draws, and never probes the snapshot", async () => {
    const { ports: p, asked } = ports(true, WEBKIT);
    const decision = createBackendDecision(p);
    expect(await decision.backend()).toBe("html-in-canvas");
    expect(asked).toEqual(["html"]);
  });

  it("falls to the snapshot where html-in-canvas does not draw, keeping its quirks", async () => {
    const { ports: p, asked } = ports(false, WEBKIT);
    const decision = createBackendDecision(p);
    expect(await decision.backend()).toBe("snapshot");
    expect(decision.quirks()).toEqual(WEBKIT);
    expect(asked).toEqual(["html", "snapshot"]);
  });

  it("falls to the snapshot when the html-in-canvas probe throws", async () => {
    const { ports: p } = ports(new Error("probe"), NO_QUIRKS);
    expect(await createBackendDecision(p).backend()).toBe("snapshot");
  });

  it("answers none only when neither draws", async () => {
    expect(await createBackendDecision(ports(false, null).ports).backend()).toBe("none");
    expect(await createBackendDecision(ports(false, new Error("x")).ports).backend()).toBe("none");
  });

  it("asks once however many callers wait, and is known synchronously after", async () => {
    const { ports: p, asked } = ports(false, NO_QUIRKS);
    const decision = createBackendDecision(p);
    expect(decision.known()).toBeNull();
    const answers = await Promise.all([decision.backend(), decision.backend(), decision.backend()]);
    expect(answers).toEqual(["snapshot", "snapshot", "snapshot"]);
    expect(await decision.backend()).toBe("snapshot");
    expect(asked).toEqual(["html", "snapshot"]);
    expect(decision.known()).toBe("snapshot");
  });
});

class FakePort implements HtmlRasterPort {
  calls: string[] = [];
  constructor(readonly name: string) {}
  supported() {
    return true;
  }
  mount(id: string, _spec: MountSpec) {
    this.calls.push(`mount ${id}`);
  }
  apply(id: string, _state: ApplyState) {
    this.calls.push(`apply ${id}`);
  }
  settle() {
    this.calls.push("settle");
    return Promise.resolve(true);
  }
  rasterize(id: string) {
    this.calls.push(`rasterize ${id}`);
    return null;
  }
  release() {
    this.calls.push("release");
  }
  unmount(id: string) {
    this.calls.push(`unmount ${id}`);
  }
}

describe("GraphicHost", () => {
  const spec = {} as MountSpec;
  const state = {} as ApplyState;

  it("is an empty host until the backend is known, and makes nothing to release", async () => {
    let known: "snapshot" | null = null;
    const made: FakePort[] = [];
    const host = new GraphicHost(
      () => known,
      (backend) => {
        const port = new FakePort(backend);
        made.push(port);
        return port;
      },
    );
    expect(host.supported()).toBe(false);
    host.release(new Set());
    host.unmount("a");
    expect(await host.settle()).toBe(true);
    expect(made).toEqual([]);
    known = "snapshot";
    expect(host.supported()).toBe(true);
    host.mount("a", spec);
    host.apply("a", state);
    expect(made.map((p) => p.name)).toEqual(["snapshot"]);
    expect(made[0].calls).toEqual(["mount a", "apply a"]);
  });

  it("makes one inner host and forwards everything to it", async () => {
    const made: FakePort[] = [];
    const host = new GraphicHost(
      () => "html-in-canvas",
      (backend) => {
        const port = new FakePort(backend);
        made.push(port);
        return port;
      },
    );
    host.mount("a", spec);
    await host.settle();
    host.rasterize("a", 4, 4);
    host.release(new Set());
    host.unmount("a");
    expect(made).toHaveLength(1);
    expect(made[0].calls).toEqual(["mount a", "settle", "rasterize a", "release", "unmount a"]);
  });

  it("never makes a host for none", () => {
    let made = 0;
    const host = new GraphicHost(
      () => "none",
      () => {
        made += 1;
        return new FakePort("x");
      },
    );
    expect(host.supported()).toBe(false);
    host.mount("a", spec);
    expect(made).toBe(0);
  });
});
