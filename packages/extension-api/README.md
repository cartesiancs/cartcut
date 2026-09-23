# Writing a Cartcut extension

An extension is a folder with a `package.json` and a JavaScript entry point.
It runs in the **extension host**, which is a separate process: it has Node,
it has your own `node_modules`, and it has no way to reach the editor except
the calls in `cartcut.d.ts`.

That boundary is what the whole design rests on. A crash in your extension
costs the user your extension and nothing else. An infinite loop costs your
extension's panel and nothing else. The timeline, the undo history and the
unsaved project are in another process and cannot be touched except by asking.

## The smallest extension

```
acme.hello/
  package.json
  main.js
```

```jsonc
{
  "name": "hello",
  "publisher": "acme",
  "version": "1.0.0",
  "main": "main.js",
  "engines": { "cartcut": "^1" },
  "cartcut": {
    "activationEvents": ["onCommand:hello.say"],
    "permissions": ["timeline.write"],
    "contributes": {
      "commands": [{ "id": "hello.say", "title": "Hello: Say" }]
    }
  }
}
```

```js
const cartcut = require("cartcut");

exports.activate = (ctx) => {
  ctx.subscriptions.push(
    cartcut.commands.registerCommand("hello.say", async () => {
      const info = await cartcut.project.info();
      await cartcut.timeline.addText({ text: "Hello", startMs: info.playheadMs, durationMs: 2000 });
    }),
  );
};
```

Load it with **Extensions > Load unpacked** while you work on it. Saving a file
restarts the host, so your next click runs the new code.

## The folder name is the id

`publisher.name`, lowercase. An installed extension's folder must be named
exactly that, because the id is the host of the `cartcut-ext://` URL your
pages are served from. An unpacked folder can be called anything.

## Activation events

Your extension does nothing until one of these happens. Declare only what you
need: `"*"` works and is what you want while developing, but it means every
user pays for loading you on every launch.

| Event | When |
| --- | --- |
| `onStartup` | The editor is ready |
| `onProjectOpen` | A project was opened |
| `onCommand:<id>` | One of your commands was invoked |
| `onView:<id>` | One of your views became visible |
| `onFiletype:<ext>` | A file of that type was touched |
| `*` | All of the above |

## Permissions

Listed at install time, in the user's own words, before anything is written to
disk. Read-only access to the timeline needs none.

| Permission | What it allows |
| --- | --- |
| `timeline.write` | Any command that changes the project |
| `project.write` | Storing your own data on a clip or in the project file |
| `fs.read` / `fs.write` | Files in your storage, your folder, the project folder, and folders the user picks |
| `process.spawn` | Running programs, including the bundled FFmpeg |
| `net` | The network |
| `clipboard` | Reading and writing the clipboard |
| `shell.open` | Opening links and files in other apps |
| `secrets` | The system keychain |
| `ai.tools` | Offering tools to Claude Code |

**Be honest about what this is.** The host is a Node process, so an extension
that wants the filesystem can `require("fs")` whatever its manifest says.
Permissions are a disclosure model and an API gate, not a sandbox. The wall
that protects the user's project is the process boundary and the fact that
every edit goes through one checked path. Install extensions you trust, the
same way you would a VS Code extension.

## Editing

Every call in `cartcut.timeline` runs the same command a Claude Code tool call
runs. So each one is a single undo step, each respects the caption-session
lock, and each is checked against the same field allowlist.

For several edits at once, use `commands.batch`. Three calls are three undo
steps; one batch of three is one.

```js
await cartcut.commands.batch([
  { name: "add_text", params: { text: "One", startMs: 0, durationMs: 1000 } },
  { name: "add_text", params: { text: "Two", startMs: 1500, durationMs: 1000 } },
]);
```

Steps run in order and each sees the previous one's result. If one throws,
nothing is applied.

## Views

A view is an HTML page in your folder, shown in a `<webview>`. It gets its own
process, its own storage, and a strict CSP: `script-src 'self'`, so put your
script in a file, and `connect-src 'none'`, so it has no network of its own.
If your page needs something from outside, ask your extension for it.

```js
const api = acquireCartcutApi();
api.postMessage({ hello: true });
api.onMessage((message) => console.log(message));
```

## Effects, transitions and LUTs

Put them in a `presets/` folder in the format the app already uses: a folder
per preset with a `manifest.json` and its GLSL. They are loaded by the same
validator that loads the built-in ones, and they disappear when your extension
is disabled. **No JavaScript runs in the render path**, by design.

## Types

```
npm install --save-dev @cartcut/extension-api
```

```jsonc
{ "compilerOptions": { "types": ["@cartcut/extension-api"] } }
```
