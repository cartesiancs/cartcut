import { describe, expect, it } from "vitest";
import { createScrollerWatch, type WatchNode } from "./scrollerWatch";

/** An element reduced to the tree walk, plus the two styles the watch reads. */
class Node implements WatchNode<Node> {
  children: Node[] = [];
  parentElement: Node | null = null;
  connectedRoot = false;

  constructor(
    readonly name: string,
    readonly style: { scroller?: boolean; boxless?: boolean } = {},
  ) {}

  get isConnected(): boolean {
    let n: Node | null = this;
    while (n.parentElement != null) {
      n = n.parentElement;
    }
    return n.connectedRoot;
  }

  append(...nodes: Node[]): this {
    for (const node of nodes) {
      node.remove();
      node.parentElement = this;
      this.children.push(node);
    }
    return this;
  }

  remove(): void {
    const parent = this.parentElement;
    if (parent != null) {
      parent.children = parent.children.filter((c) => c !== this);
      this.parentElement = null;
    }
  }

  querySelectorAll(): Node[] {
    return this.children.flatMap((c) => [c, ...c.querySelectorAll()]);
  }
}

const el = (name: string, style?: Node["style"], ...children: Node[]) =>
  new Node(name, style).append(...children);

function harness() {
  const document = el("document");
  document.connectedRoot = true;
  const observed = new Set<string>();
  const resized: string[] = [];
  let frame: (() => void) | null = null;
  let frames = 0;
  let styleReads = 0;

  const watch = createScrollerWatch<Node>({
    isScroller: (n) => {
      styleReads++;
      return n.style.scroller === true;
    },
    isBoxless: (n) => n.style.boxless === true,
    observe: (n) => observed.add(n.name),
    unobserve: (n) => observed.delete(n.name),
    resized: (n) => resized.push(n.name),
    frame: (callback) => {
      frames++;
      frame = callback;
    },
  });

  return {
    document,
    watch,
    observed,
    resized,
    get frames() {
      return frames;
    },
    get styleReads() {
      return styleReads;
    },
    /** Run the frame the watch asked for. */
    settle() {
      const run = frame;
      frame = null;
      run?.();
    },
  };
}

describe("createScrollerWatch", () => {
  it("watches each scroller and each of its children, and nothing else", () => {
    const h = harness();
    const list = el(
      "list",
      { scroller: true },
      el("a", {}, el("a-deep")),
      el("b"),
    );
    h.document.append(el("panel", {}, list));
    h.watch.added(h.document);
    h.settle();

    expect([...h.observed].sort()).toEqual(["a", "b", "list"]);
  });

  it("watches through a child that has no box of its own", () => {
    const h = harness();
    h.document.append(
      el(
        "list",
        { scroller: true },
        el("wrapper", { boxless: true }, el("row-1"), el("row-2")),
      ),
    );
    h.watch.added(h.document);
    h.settle();

    expect([...h.observed].sort()).toEqual([
      "list",
      "row-1",
      "row-2",
      "wrapper",
    ]);
  });

  it("reports a resize of the scroller or any of its children as the scroller's", () => {
    const h = harness();
    const row = el("row");
    const list = el("list", { scroller: true }, row);
    h.document.append(list);
    h.watch.added(h.document);
    h.settle();

    h.watch.sized(row);
    h.watch.sized(list);
    h.watch.sized(el("stranger"));
    expect(h.resized).toEqual(["list", "list"]);
  });

  it("reports a nested scroller's resize to itself and to the one around it", () => {
    const h = harness();
    const inner = el("inner", { scroller: true });
    h.document.append(el("outer", { scroller: true }, inner));
    h.watch.added(h.document);
    h.settle();

    h.watch.sized(inner);
    expect(h.resized).toEqual(["inner", "outer"]);
  });

  it("watches a child added to a scroller, or to a boxless child of one", () => {
    const h = harness();
    const wrapper = el("wrapper", { boxless: true });
    const list = el("list", { scroller: true }, wrapper);
    h.document.append(list);
    h.watch.added(h.document);
    h.settle();

    const direct = el("direct");
    const wrapped = el("wrapped");
    list.append(direct);
    wrapper.append(wrapped);
    h.watch.added(direct);
    h.watch.added(wrapped);
    h.settle();

    expect(h.observed.has("direct")).toBe(true);
    expect(h.observed.has("wrapped")).toBe(true);
  });

  it("leaves a node added deeper inside a child to that child's box", () => {
    const h = harness();
    const row = el("row");
    h.document.append(el("list", { scroller: true }, row));
    h.watch.added(h.document);
    h.settle();

    const cell = el("cell");
    row.append(cell);
    h.watch.added(cell);
    h.settle();

    expect(h.observed.has("cell")).toBe(false);
  });

  it("finds a scroller that arrives after boot", () => {
    const h = harness();
    h.watch.added(h.document);
    h.settle();

    const menu = el("menu", { scroller: true }, el("item"));
    h.document.append(menu);
    h.watch.added(menu);
    h.settle();

    expect([...h.observed].sort()).toEqual(["item", "menu"]);
  });

  it("forgets a removed subtree, and measures the scroller it left", () => {
    const h = harness();
    const row = el("row", {}, el("inner-list", { scroller: true }, el("x")));
    const list = el("list", { scroller: true }, row, el("other"));
    h.document.append(list);
    h.watch.added(h.document);
    h.settle();

    row.remove();
    h.watch.removed(row);
    h.settle();

    expect([...h.observed].sort()).toEqual(["list", "other"]);
    // Its box did not move, so nothing else would have measured it.
    expect(h.resized).toEqual(["list"]);
  });

  it("finds a moved scroller again under its new parent", () => {
    const h = harness();
    const list = el("list", { scroller: true }, el("row"));
    const a = el("a");
    const b = el("b");
    h.document.append(a.append(list), b);
    h.watch.added(h.document);
    h.settle();

    b.append(list);
    h.watch.removed(list);
    h.watch.added(list);
    h.settle();

    expect([...h.observed].sort()).toEqual(["list", "row"]);
    h.watch.sized(list);
    expect(h.resized).toEqual(["list"]);
  });

  it("ignores a node added and removed within one frame", () => {
    const h = harness();
    h.watch.added(h.document);
    h.settle();

    const flash = el("flash", { scroller: true });
    h.document.append(flash);
    h.watch.added(flash);
    flash.remove();
    h.watch.removed(flash);
    h.settle();

    expect(h.observed.has("flash")).toBe(false);
  });

  it("settles a burst of mutations in one frame, reading each style once", () => {
    const h = harness();
    const rows = [el("r1", {}, el("r1-cell")), el("r2"), el("r3")];
    const body = el("body", {}, ...rows);
    h.document.append(body);

    // Lit reports the body, and then each row it rendered inside it.
    h.watch.added(body);
    for (const row of rows) {
      h.watch.added(row);
    }
    h.settle();

    expect(h.frames).toBe(1);
    expect(h.styleReads).toBe(5);
  });
});
