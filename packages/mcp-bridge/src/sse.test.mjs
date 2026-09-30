import { describe, expect, it } from "vitest";
import { createSseParser } from "./sse.mjs";

function parse(chunks) {
  const events = [];
  const parser = createSseParser((event) => events.push(event));
  for (const chunk of chunks) {
    parser.push(chunk);
  }
  return events;
}

describe("createSseParser", () => {
  it("reads the frames the MCP SDK writes", () => {
    expect(
      parse(['event: message\ndata: {"jsonrpc":"2.0","id":1,"result":{}}\n\n']),
    ).toEqual([{ event: "message", data: '{"jsonrpc":"2.0","id":1,"result":{}}' }]);
  });

  it("gives the same events however the stream is chunked", () => {
    const stream =
      "event: message\r\ndata: a\r\ndata: b\r\n\r\n: keep-alive\n\ndata: c\rid: 7\r\r\n";
    const whole = parse([stream]);
    expect(whole).toEqual([
      { event: "message", data: "a\nb" },
      { event: "message", data: "c" },
    ]);
    for (let size = 1; size <= 5; size++) {
      const chunks = [];
      for (let i = 0; i < stream.length; i += size) {
        chunks.push(stream.slice(i, i + size));
      }
      expect(parse(chunks)).toEqual(whole);
    }
  });

  it("holds a CR that ends a chunk until it knows whether LF follows", () => {
    // Read as a line ending on its own, the CR would make the LF a blank
    // line and dispatch "a" before "b" arrived.
    expect(parse(["data: a\r", "\ndata: b\r\n\r\n"])).toEqual([
      { event: "message", data: "a\nb" },
    ]);
  });

  it("dispatches nothing for an event with no data, and nothing unfinished", () => {
    expect(parse(["event: ping\n\n", "data: half"])).toEqual([]);
  });
});
