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

/** The selection to hold after the visible set changes: keep the current one
 *  while it is still on screen, otherwise fall back to the top row.
 *
 *  That fallback is what makes the panel a one-keystroke jump. The rows
 *  arrive after the panel opens, so the first call comes with no selection at
 *  all and settles on the most urgent session (Needs you is rendered first);
 *  Enter then opens it without an arrow key in between. Typing in the
 *  launcher's search bar re-runs this with the filtered ids, so the top match
 *  is selected as the operator types and Enter jumps straight to it. */
export function settleSelection(ids: readonly string[], selected: string | null): string | null {
  if (ids.length === 0) return null;
  if (selected !== null && ids.includes(selected)) return selected;
  return ids[0];
}
