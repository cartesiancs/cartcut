/**
 * A server-sent events parser for the streams CartCut answers with.
 *
 * Fed whatever chunks the socket delivers, which split wherever they like:
 * inside a line, or between the `\r` and the `\n` of one line ending. A `\r`
 * that ends a chunk is held back until the next one says whether a `\n`
 * follows; read as a line ending on its own, it would make the `\n` a blank
 * line and dispatch the event early, splitting one multi-line `data` in two.
 *
 * `id` and `retry` are read past: the bridge never resumes a stream.
 */

const LINE_END = /\r\n|\r(?!$)|\n/g;

export function createSseParser(onEvent) {
  let buffer = "";
  let data = [];
  let event = "";

  function dispatch() {
    if (data.length > 0) {
      onEvent({ event: event || "message", data: data.join("\n") });
    }
    data = [];
    event = "";
  }

  function line(text) {
    if (text === "") {
      dispatch();
      return;
    }
    if (text.startsWith(":")) {
      return;
    }
    const colon = text.indexOf(":");
    const field = colon === -1 ? text : text.slice(0, colon);
    let value = colon === -1 ? "" : text.slice(colon + 1);
    if (value.startsWith(" ")) {
      value = value.slice(1);
    }
    if (field === "data") {
      data.push(value);
    } else if (field === "event") {
      event = value;
    }
  }

  return {
    push(chunk) {
      buffer += chunk;
      LINE_END.lastIndex = 0;
      let start = 0;
      let match;
      while ((match = LINE_END.exec(buffer)) != null) {
        line(buffer.slice(start, match.index));
        start = match.index + match[0].length;
      }
      buffer = buffer.slice(start);
    },
  };
}
