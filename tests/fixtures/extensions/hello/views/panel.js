// No inline script: the CSP the scheme handler sends is `script-src 'self'`,
// so a page that inlines its script silently does nothing. That is the
// intended shape, and this file is what proves an extension author can work
// with it.
const api = acquireCartcutApi();
const log = document.getElementById("log");

function append(line) {
  log.textContent += line + "\n";
}

api.onMessage((message) => append("from the host: " + JSON.stringify(message)));

document.getElementById("ping").addEventListener("click", () => {
  const at = new Date().toISOString();
  api.postMessage({ hello: "from the panel", at });
  append("sent at " + at);
});

append("window.electronAPI is " + typeof window.electronAPI);
