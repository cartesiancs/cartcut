/**
 * The behaviour of a strip of `.tb-tab` chips that scrolls sideways.
 *
 * `<preview-top-bar>` grew these first; the timeline tabs in the title bar
 * need exactly the same strip, so the arithmetic is here and the look is the
 * shared `.tb-tab-strip` in `_toolbar.scss`. Plain functions over the
 * scroller element, so a component keeps its own state and render.
 */

/** Whether the strip is scrolled away from its left and right edges. */
export function tabStripOverflow(scroller: HTMLElement): {
  start: boolean;
  end: boolean;
} {
  // Sub-pixel layout leaves a fraction of scroll room on a strip that
  // already fits, so a whole pixel is the threshold.
  const maxScroll = scroller.scrollWidth - scroller.clientWidth;
  return {
    start: scroller.scrollLeft > 1,
    end: scroller.scrollLeft < maxScroll - 1,
  };
}

/** Scroll `tab` into view, clear of the edge fade. */
export function scrollTabIntoView(scroller: HTMLElement, tab: HTMLElement): void {
  const view = scroller.getBoundingClientRect();
  const rect = tab.getBoundingClientRect();
  const left = rect.left - view.left + scroller.scrollLeft;
  const right = left + rect.width;
  const fade = 24;
  if (left - fade < scroller.scrollLeft) {
    scroller.scrollLeft = Math.max(0, left - fade);
  } else if (right + fade > scroller.scrollLeft + scroller.clientWidth) {
    scroller.scrollLeft = right + fade - scroller.clientWidth;
  }
}

/**
 * A plain mouse only produces `deltaY`, and the strip scrolls on X alone, so
 * without this the tabs it hides would be unreachable outside a trackpad.
 */
export function wheelTabStrip(event: WheelEvent): void {
  const scroller = event.currentTarget as HTMLElement;
  if (scroller.scrollWidth <= scroller.clientWidth) {
    return;
  }
  const delta =
    Math.abs(event.deltaX) > Math.abs(event.deltaY) ? event.deltaX : event.deltaY;
  if (delta === 0) {
    return;
  }
  event.preventDefault();
  scroller.scrollLeft += delta;
}
