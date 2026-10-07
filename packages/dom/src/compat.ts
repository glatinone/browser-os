import type { ActionType, SemanticElement } from '@browser-os/protocol';

/**
 * Checks whether an element is compatible with an action type (action-router §5).
 * - fill: state.editable or role in {textbox, searchbox, combobox, spinbutton}
 * - select: tag select or role in {combobox, listbox}
 * - click/hover/press: any non-disabled element
 * - upload: file input element
 * - waitFor/extract/scroll: any element
 */
export function isCompatible(element: SemanticElement, actionType?: ActionType | string): boolean {
  if (!actionType) return true;
  switch (actionType) {
    case 'fill':
      return Boolean(
        !element.state.disabled &&
          (element.state.editable || ['textbox', 'searchbox', 'combobox', 'spinbutton'].includes(element.role)),
      );
    case 'select':
      return Boolean(
        !element.state.disabled && (element.tag === 'select' || ['combobox', 'listbox'].includes(element.role)),
      );
    case 'click':
    case 'hover':
    case 'press':
      return !element.state.disabled;
    case 'upload':
      return !element.state.disabled && element.inputType === 'file';
    case 'waitFor':
    case 'extract':
    case 'scroll':
      return true;
    default:
      return true;
  }
}
