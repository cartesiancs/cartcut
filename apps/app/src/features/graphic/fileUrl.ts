/**
 * An absolute path as a URL the renderer can load: a `file://` URL with every
 * character that would end or redirect it escaped.
 *
 * `functions/path.ts#encode` escapes `#` alone, which is right for the
 * `localpath` strings `mergeOps` compares and wrong here: this string goes into
 * CSS and into an `<img src>`, where a space, a quote or a `?` would each change
 * what is loaded. Windows paths get their drive letter after a third slash.
 */
export function fileUrlOf(path: string): string {
  const posix = path.replace(/\\/g, "/");
  const rooted = posix.startsWith("/") ? posix : "/" + posix;
  return "file://" + encodeURI(rooted).replace(/#/g, "%23").replace(/\?/g, "%3F");
}
