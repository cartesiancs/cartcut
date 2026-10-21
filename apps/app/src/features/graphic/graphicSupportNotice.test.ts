import { describe, expect, it } from "vitest";
import { UNSUPPORTED_TITLES_MESSAGE, createSupportNotice } from "./graphicSupportNotice";

function harness(desktop: boolean, answers: Array<boolean | Error>) {
  const shown: string[] = [];
  let asked = 0;
  const notice = createSupportNotice({
    desktop: () => desktop,
    supported: () => {
      const answer = answers[Math.min(asked, answers.length - 1)];
      asked += 1;
      return answer instanceof Error ? Promise.reject(answer) : Promise.resolve(answer);
    },
    show: (message) => shown.push(message),
  });
  return { notice, shown, asked: () => asked };
}

const flush = async () => {
  for (let i = 0; i < 5; i++) await Promise.resolve();
};

describe("graphic support notice", () => {
  it("tells a browser that cannot draw titles once, however many frames need them", async () => {
    const { notice, shown, asked } = harness(false, [false]);
    notice.needed();
    notice.needed();
    await flush();
    notice.needed();
    await flush();
    expect(shown).toEqual([UNSUPPORTED_TITLES_MESSAGE]);
    expect(asked()).toBe(1);
  });

  it("says nothing where titles draw, and stops asking", async () => {
    const { notice, shown, asked } = harness(false, [true]);
    notice.needed();
    await flush();
    notice.needed();
    await flush();
    expect(shown).toEqual([]);
    expect(asked()).toBe(1);
  });

  it("never asks in the desktop app", async () => {
    const { notice, shown, asked } = harness(true, [false]);
    notice.needed();
    await flush();
    expect(shown).toEqual([]);
    expect(asked()).toBe(0);
  });

  it("asks again after a question that failed", async () => {
    const { notice, shown, asked } = harness(false, [new Error("probe threw"), false]);
    notice.needed();
    await flush();
    expect(shown).toEqual([]);
    notice.needed();
    await flush();
    expect(shown).toEqual([UNSUPPORTED_TITLES_MESSAGE]);
    expect(asked()).toBe(2);
  });
});
