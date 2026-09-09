import { describe, expect, it, beforeEach } from "vitest";
import {
  beginMediaLoad,
  mediaLoadStore,
  whileLoadingMedia,
} from "./mediaLoadStore";

describe("mediaLoadStore", () => {
  beforeEach(() => {
    mediaLoadStore.setState({ pending: 0 });
  });

  it("counts concurrent loads rather than flagging one", () => {
    const { begin, end } = mediaLoadStore.getState();
    begin();
    begin();
    end();

    // A flag would read as "done" here, with one probe still running.
    expect(mediaLoadStore.getState().pending).toBe(1);
  });

  it("declines at zero, without notifying", () => {
    let notifications = 0;
    const unsubscribe = mediaLoadStore.subscribe(() => {
      notifications += 1;
    });

    mediaLoadStore.getState().end();

    unsubscribe();
    expect(mediaLoadStore.getState().pending).toBe(0);
    expect(notifications).toBe(0);
  });

  it("lowers the indicator when the work throws", async () => {
    await expect(
      whileLoadingMedia(async () => {
        expect(mediaLoadStore.getState().pending).toBe(1);
        throw new Error("unreadable");
      }),
    ).rejects.toThrow("unreadable");

    expect(mediaLoadStore.getState().pending).toBe(0);
  });

  it("latches the release, so one exit cannot lower another load", () => {
    const release = beginMediaLoad();
    beginMediaLoad();

    // An `add*` method that both errored and loaded — or that caught after
    // already releasing — must not take the second import's count with it.
    release();
    release();
    release();

    expect(mediaLoadStore.getState().pending).toBe(1);
  });

  it("stays up across overlapping windows", () => {
    // The click raises one, and the probe it starts raises another before the
    // click's is released. Nothing in between reads zero, so the bar cannot
    // blink off and on again mid-import.
    const click = beginMediaLoad();
    const probe = beginMediaLoad();
    click();

    expect(mediaLoadStore.getState().pending).toBe(1);
    probe();
    expect(mediaLoadStore.getState().pending).toBe(0);
  });

  it("returns what the work returned", async () => {
    await expect(whileLoadingMedia(async () => 7)).resolves.toBe(7);
    expect(mediaLoadStore.getState().pending).toBe(0);
  });
});
