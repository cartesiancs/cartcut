interface Window {
  electronAPI: any;
}

// Set by the <script> tag in index.html, not by the bundle — see
// apps/app/vendor/README.md.
declare var bootstrap: any;
declare var CARTCUT: any;

interface Document {
  querySelector(selectors: string): any;
}
