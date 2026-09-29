/**
 * The asset library's right-click menu: one row, Show Info.
 *
 * Written into `#menuRightClick`, the container the timeline's menu uses, so
 * the two can never be open at once: opening either replaces the other.
 *
 * The row's action is attached as a listener, not as the inline `onclick`
 * string the timeline menu builds. That string would have to carry the file's
 * path, and a path is free text: a quote ends the attribute and a backslash
 * starts an escape. Here the path never enters the markup.
 */

import { openMediaInfo } from "./mediaInfoSession";
import type { InfoTarget } from "./mediaInfoView";

export function showAssetMenu(x: number, y: number, target: InfoTarget): void {
  const host = document.querySelector("#menuRightClick");
  if (host == null) {
    return;
  }

  host.innerHTML = `
    <menu-dropdown-body top="${Math.round(y)}" left="${Math.round(x)}">
      <menu-dropdown-item item-name="Show Info" item-icon="info"></menu-dropdown-item>
    </menu-dropdown-body>`;

  // Runs before the click reaches `document`, where the menu dismisses itself.
  host
    .querySelector("menu-dropdown-item")
    ?.addEventListener("click", () => openMediaInfo(target));
}
