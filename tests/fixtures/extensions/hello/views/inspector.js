// A section is handed no element id. It asks its extension, which knows what
// is selected and can push updates without this page reloading.
const api = acquireCartcutApi();
const who = document.getElementById("who");

api.onMessage((message) => {
  who.textContent = "selected: " + JSON.stringify(message);
});

api.postMessage({ want: "selection" });
