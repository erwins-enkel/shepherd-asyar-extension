// ─────────────────────────────────────────────────────────────────────────
// selection.ts — which row the ArrowDown/ArrowUp keys land on.
//
// Pure on purpose. The panel can't drive selection with DOM focus: when a
// view is open the launcher intercepts ArrowUp/ArrowDown/Enter/Tab in its own
// window-capture handler, calls preventDefault() + stopPropagation(), and
// re-delivers them to the iframe as an `asyar:view:keydown` postMessage
// (`tryRouteToActiveView` in asyar-launcher/src/lib/keyboard/launcherKeyboard.ts
// → `ExtensionIframeManager.forwardKeyToActiveView`). So no keystroke ever
// reaches this iframe's DOM while the launcher's search bar has focus, and
// calling .focus() on a row in response would pull focus off that search bar
// and break the typing that drives the filter. Selection is therefore virtual
// state, moved by these functions and rendered as `aria-activedescendant`.
// ─────────────────────────────────────────────────────────────────────────

export type SelectionKey = 'ArrowDown' | 'ArrowUp';

/** The next selected row id after `key`, over the visible row ids in render
 *  order. Wraps at both ends, matching the launcher's own root result list
 *  (`tryHandleSearchNavigation` uses `(current ± 1) % totalItems`).
 *
 *  A `selected` id that is no longer in `ids` — the filter moved out from
 *  under it — is treated the same as no selection at all: ArrowDown restarts
 *  at the top, ArrowUp at the bottom. */
export function moveSelection(
  ids: readonly string[],
  selected: string | null,
  key: SelectionKey,
): string | null {
  if (ids.length === 0) return null;

  const index = selected === null ? -1 : ids.indexOf(selected);
  if (index === -1) return key === 'ArrowDown' ? ids[0] : ids[ids.length - 1];

  const next = key === 'ArrowDown' ? index + 1 : index - 1 + ids.length;
  return ids[next % ids.length];
}

/** Drops a selection the currently visible rows no longer contain, so a
 *  filter keystroke that hides the selected row clears the highlight instead
 *  of leaving `aria-activedescendant` pointing at an id that isn't rendered. */
export function keepSelection(ids: readonly string[], selected: string | null): string | null {
  if (selected === null) return null;
  return ids.includes(selected) ? selected : null;
}
