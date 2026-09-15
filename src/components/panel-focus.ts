import type { FocusEvent } from "react";

/** Nonmodal drawers yield space when focus leaves, without moving that focus.
 * A modal temporarily owns focus and will return it to the still-open drawer.
 */
export function shouldDismissDrawer(event: FocusEvent<HTMLElement>) {
  const next = event.relatedTarget;
  return (
    next instanceof Element &&
    !event.currentTarget.contains(next) &&
    !next.closest("[role='dialog'][data-open]")
  );
}
