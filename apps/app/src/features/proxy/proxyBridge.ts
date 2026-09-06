/**
 * Keeping the renderer's idea of what proxies exist in step with the disk.
 *
 * Main owns the files and the index; this pulls that across once at startup and
 * again whenever a generation pass changes it. Nothing polls — a proxy appears
 * only because someone asked for one.
 *
 * The paths cross the boundary in **OS form**, because that is what `fs` and
 * `ffmpeg` speak, and are converted to `file://` here so the store can be keyed
 * the same way `element.localpath` is. Doing it at one place rather than at each
 * call site is what keeps the store's key meaningful.
 */

import { proxyStore, type ProxyEntry } from "../../states/proxyStore";
import { toLocalPathKey } from "./proxyPath";

type MainEntry = {
  source: string;
  proxy: string;
  width: number;
  height: number;
  fps: number;
};

/** Ask main what exists, and write it into the store keyed by `localpath`. */
export async function refreshProxies(): Promise<void> {
  const api = (window as any).electronAPI?.req?.proxy;
  if (api == null) {
    // The web build has no main process, and therefore no proxies. Not an
    // error: `playbackPathFor` falls through to the original either way.
    return;
  }

  try {
    const bySourceOsPath: Record<string, MainEntry> = await api.list();
    const bySource: Record<string, ProxyEntry> = {};
    for (const entry of Object.values(bySourceOsPath)) {
      bySource[toLocalPathKey(entry.source)] = {
        source: toLocalPathKey(entry.source),
        proxy: entry.proxy,
        width: entry.width,
        height: entry.height,
        fps: entry.fps,
      };
    }
    proxyStore.getState().setEntries(bySource);
  } catch (error) {
    console.error("[proxy] could not read the proxy index:", error);
  }
}

/**
 * Subscribe to generation progress, once, at startup.
 *
 * Returns a disposer for symmetry, though nothing tears this down in practice —
 * the listeners live as long as the window does.
 */
export function installProxyBridge(): () => void {
  const api = (window as any).electronAPI?.req?.proxy;
  if (api == null) {
    return () => {};
  }

  const offProgress = api.onProgress((p: any) =>
    proxyStore.getState().setProgress(p),
  );
  const offDone = api.onDone(() => {
    proxyStore.getState().setProgress(null);
    void refreshProxies();
  });

  void refreshProxies();

  return () => {
    offProgress?.();
    offDone?.();
  };
}
