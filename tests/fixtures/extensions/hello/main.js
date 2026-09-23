/**
 * The fixture extension.
 *
 * Deliberately exercises the two failures the whole design exists to survive:
 * `hello.crash` kills the host process outright and `hello.hang` never
 * returns. After either, the editor has to still be responsive, the timeline
 * unchanged, and the undo stack exactly where it was.
 *
 * Plain CommonJS with no dependencies, so it loads in a checkout with no
 * install step.
 */

const cartcut = require("cartcut");

let status = null;

async function activate(ctx) {
  ctx.log.info("hello activated from", ctx.extensionPath);

  ctx.subscriptions.push(
    cartcut.commands.registerCommand("hello.say", async () => {
      const greeting = (await cartcut.config.get("hello.greeting")) || "Hello";
      const shout = (await cartcut.config.get("hello.shout")) === true;
      const text = shout ? String(greeting).toUpperCase() : String(greeting);
      const info = await cartcut.project.info();

      const result = await cartcut.timeline.addText({
        text,
        startMs: info.playheadMs || 0,
        durationMs: 2000,
      });
      await cartcut.window.showMessage(text + " from acme.hello");
      return result;
    }),
  );

  ctx.subscriptions.push(
    cartcut.commands.registerCommand("hello.batch", () =>
      // Three titles, one undo step. The claim the collector exists for.
      cartcut.commands.batch([
        { name: "add_text", params: { text: "One", startMs: 0, durationMs: 1000 } },
        { name: "add_text", params: { text: "Two", startMs: 1500, durationMs: 1000 } },
        { name: "add_text", params: { text: "Three", startMs: 3000, durationMs: 1000 } },
      ]),
    ),
  );

  ctx.subscriptions.push(
    cartcut.commands.registerCommand("hello.tag", async () => {
      const ids = await cartcut.selection.get();
      const first = ids[0];
      if (first == null) {
        await cartcut.window.showMessage("Select a clip first.", "warn");
        return null;
      }
      await cartcut.timeline.setElementData(first, { taggedAt: Date.now() });
      // Read back through two different paths: the clip's own detail, which
      // shows an extension its own key and shows Claude Code none, and the
      // direct accessor.
      const clip = await cartcut.timeline.getClip(first);
      const direct = await cartcut.timeline.getElementData(first);
      ctx.log.info("tagged", first, JSON.stringify(clip.ext), JSON.stringify(direct));
      return clip.ext;
    }),
  );

  ctx.subscriptions.push(
    cartcut.commands.registerCommand("hello.note", async () => {
      await cartcut.project.data.set({ note: "written by the fixture", at: Date.now() });
      await cartcut.window.showMessage("Stored a note in the project file.");
      return null;
    }),
  );

  ctx.subscriptions.push(
    cartcut.commands.registerCommand("hello.crash", () => {
      // Not a throw. A throw is caught and reported; this takes the whole host
      // process down, which is the case the editor has to survive untouched.
      process.exit(3);
    }),
  );

  ctx.subscriptions.push(
    cartcut.commands.registerCommand("hello.hang", () => {
      // A busy loop, so the process cannot even service its own port. The
      // editor stays responsive because this is a different process.
      for (;;) {
        // Intentionally empty.
      }
    }),
  );

  ctx.subscriptions.push(
    cartcut.ai.registerTool({
      name: "say_hello",
      description: "Add a title that greets someone, at the playhead.",
      inputSchema: {
        type: "object",
        properties: { name: { type: "string" } },
        required: ["name"],
      },
      handler: async (args) => {
        const info = await cartcut.project.info();
        return cartcut.timeline.addText({
          text: "Hello, " + String((args && args.name) || "world"),
          startMs: info.playheadMs || 0,
          durationMs: 2000,
        });
      },
    }),
  );

  ctx.subscriptions.push(
    // The inspector section asks for the selection when it mounts, and is
    // told again whenever it changes. The app never passes an element id into
    // a view: doing so would reload the page on every click in the timeline.
    cartcut.ui.onViewMessage("hello.inspector", async () => {
      await cartcut.ui.postMessageToView("hello.inspector", await cartcut.selection.get());
    }),
  );

  ctx.subscriptions.push(
    cartcut.selection.onDidChange(async (event) => {
      void cartcut.ui.postMessageToView("hello.inspector", (event && event.ids) || []);
    }),
  );

  ctx.subscriptions.push(
    cartcut.ui.onViewMessage("hello.panel", async (message) => {
      ctx.log.info("panel said", JSON.stringify(message));
      await cartcut.ui.postMessageToView("hello.panel", {
        reply: "the host heard: " + JSON.stringify(message),
      });
    }),
  );

  ctx.subscriptions.push(
    cartcut.selection.onDidChange((event) => {
      const count = (event && event.ids ? event.ids : []).length;
      void cartcut.window.setStatusItem({
        id: "hello.status",
        text: count === 0 ? "Hello" : "Hello (" + count + ")",
        command: "hello.say",
      });
    }),
  );

  status = await cartcut.window.setStatusItem({ id: "hello.status", text: "Hello", command: "hello.say" });
}

function deactivate() {
  status = null;
}

module.exports = { activate, deactivate };
