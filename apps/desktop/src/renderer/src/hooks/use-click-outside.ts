import { useEffect, type RefObject } from 'react';

/**
 * Closes a popover/dropdown when a pointer press happens outside its ref.
 *
 * Used by every click-to-open panel (call settings, share menu, quality panel,
 * transmission stats) so they dismiss on outside interaction instead of
 * requiring a second toggle click. Listens on `pointerdown` (fires before
 * focus/click) and ignores presses inside the ref's subtree. Also closes on
 * Escape, matching the convention users expect from dialogs/menus.
 *
 * The handler is intentionally a no-op while `active` is false so toggling the
 * panel open does not immediately re-trigger a close from the same gesture.
 */
export function useClickOutside(
  ref: RefObject<Node | null>,
  onClose: () => void,
  active: boolean,
): void {
  useEffect(() => {
    if (!active) return;
    const onPointerDown = (event: PointerEvent): void => {
      const node = ref.current;
      if (node === null) return;
      if (event.target instanceof Node && !node.contains(event.target)) {
        onClose();
      }
    };
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onClose();
    };
    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [ref, onClose, active]);
}
