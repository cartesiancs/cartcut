/**
 * Where a graphic's own files load from: its pictures (`asset:` names, image
 * parameters) as URLs for CSS and for an `<img src>`.
 *
 * The desktop app reads them straight off disk. A browser build cannot read
 * `file://`, so at boot it installs the rule its media already follows
 * (`functions/mediaUrl.ts`, the same one `font/fontFaces.ts` installs for
 * faces): a site path for the public build, the file route for a self-hosted
 * server. Without it a template's picture is a request the page refuses, and
 * the graphic draws with a hole where the picture was.
 */
let resolver: ((path: string) => string) | null = null;

/**
 * Load every graphic file through `resolve` from now on. `null` puts back the
 * desktop answer. Called once, at boot, by a browser build.
 */
export function installGraphicAssetUrlResolver(resolve: ((path: string) => string) | null): void {
  resolver = resolve;
}

/**
 * An absolute path as a URL the renderer can load.
 *
 * On the desktop, a `file://` URL with every character that would end or
 * redirect it escaped. `functions/path.ts#encode` escapes `#` alone, which is
 * right for the `localpath` strings `mergeOps` compares and wrong here: this
 * string goes into CSS and into an `<img src>`, where a space, a quote or a `?`
 * would each change what is loaded. Windows paths get their drive letter after
 * a third slash.
 */
export function fileUrlOf(path: string): string {
  if (resolver != null) {
    return resolver(path);
  }
  const posix = path.replace(/\\/g, "/");
  const rooted = posix.startsWith("/") ? posix : "/" + posix;
  return "file://" + encodeURI(rooted).replace(/#/g, "%23").replace(/\?/g, "%3F");
}

const DESKTOP_URL = /url\(\s*["']?(#|file:)/gi;
// A root-relative path and nothing else: `//host/x` names another site.
const SITE_URL = /url\(\s*["']?(#|file:|\/(?!\/))/gi;

/**
 * Whether every `url()` in a stylesheet rule is one the host put there.
 *
 * A second check, against the browser's own parse, behind `cssFilter.ts`: that
 * pass has already removed every `url()` a program wrote except a fragment and
 * a declared `asset:` name, and `mountSpec.ts` replaced each asset name with
 * what `fileUrlOf` answers. So a rule may hold fragments and `file://` URLs,
 * and once a browser build has installed a resolver, root-relative site paths.
 * Anything else got past the first pass and the rule is dropped.
 */
export function cssUrlsAdmitted(text: string): boolean {
  const urls = text.match(/url\(/gi)?.length ?? 0;
  if (urls === 0) {
    return true;
  }
  const admitted = text.match(resolver != null ? SITE_URL : DESKTOP_URL)?.length ?? 0;
  return admitted === urls;
}
