import { describe, expect, it } from "vitest";
import { createArtPreloader } from "./artPreload";

/** A promise settled by hand. */
function deferred() {
  let resolve!: () => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** Every decode and every timer, held open until the test settles them. */
function harness() {
  const decodes = new Map<string, ReturnType<typeof deferred>>();
  const calls: string[] = [];
  const timers: { ms: number; fire: () => void }[] = [];

  const preloader = createArtPreloader(
    (src) => {
      calls.push(src);
      const d = deferred();
      decodes.set(src, d);
      return d.promise;
    },
    (ms) =>
      new Promise((resolve) => {
        timers.push({ ms, fire: resolve });
      }),
  );
  return { preloader, decodes, calls, timers };
}

/** Whether `promise` has settled once queued callbacks have run. */
async function isSettled(promise: Promise<unknown>): Promise<boolean> {
  let settled = false;
  void promise.then(
    () => (settled = true),
    () => (settled = true),
  );
  for (let i = 0; i < 5; i++) await Promise.resolve();
  return settled;
}

describe("art preloader", () => {
  it("asks for every picture once, however often it is warmed or awaited", () => {
    const { preloader, calls } = harness();

    preloader.warm(["a.svg", "b.webp", "c.webp"]);
    preloader.warm(["a.svg", "b.webp", "c.webp"]);
    void preloader.ready("b.webp", 1000);
    void preloader.ready("b.webp", 1000);

    expect(calls).toEqual(["a.svg", "b.webp", "c.webp"]);
  });

  it("starts a fetch nobody warmed when a card asks for it", () => {
    const { preloader, calls } = harness();

    void preloader.ready("late.webp", 1000);

    expect(calls).toEqual(["late.webp"]);
  });

  it("holds a card until its picture is decoded, and not after", async () => {
    const { preloader, decodes } = harness();
    preloader.warm(["a.webp"]);

    const ready = preloader.ready("a.webp", 1000);
    // The other half of the claim: an undecoded picture really does hold the
    // card, so the assertion after the decode is measuring something.
    expect(await isSettled(ready)).toBe(false);

    decodes.get("a.webp")!.resolve();
    expect(await isSettled(ready)).toBe(true);
  });

  it("lets the card through at the cap when the picture never comes", async () => {
    const { preloader, timers } = harness();

    const ready = preloader.ready("stalled.webp", 1500);
    expect(await isSettled(ready)).toBe(false);
    expect(timers.map((t) => t.ms)).toEqual([1500]);

    timers[0].fire();
    expect(await isSettled(ready)).toBe(true);
  });

  it("counts a failed picture as ready, and never rejects", async () => {
    const { preloader, decodes } = harness();

    const ready = preloader.ready("missing.webp", 1000);
    decodes.get("missing.webp")!.reject(new Error("EncodingError"));

    await expect(ready).resolves.toBeUndefined();
  });

  it("survives a decode that throws before it returns a promise", async () => {
    const preloader = createArtPreloader(
      () => {
        throw new Error("no Image here");
      },
      () => new Promise(() => {}),
    );

    preloader.warm(["a.svg"]);
    await expect(preloader.ready("a.svg", 1000)).resolves.toBeUndefined();
  });

  it("answers a second card on a picture that is already in without waiting", async () => {
    const { preloader, decodes } = harness();
    preloader.warm(["a.webp"]);
    decodes.get("a.webp")!.resolve();
    await Promise.resolve();

    expect(await isSettled(preloader.ready("a.webp", 1000))).toBe(true);
  });
});
