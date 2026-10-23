/**
 * A light tap of the Taptic Engine for placing, confirming and failing.
 *
 * Safari on iPhone has no vibration API, but since iOS 18 toggling a native
 * `<input type="checkbox" switch>` plays the system haptic, and doing so from inside a
 * touch handler works even when the switch is hidden. Elsewhere `navigator.vibrate`
 * covers Android. Either way it is silent when the player turned haptics off.
 */

import { settings } from './settings';

export type HapticKind = 'light' | 'medium' | 'error';

let label: HTMLLabelElement | null = null;
let last = 0;

function iosSwitch(): HTMLLabelElement {
  if (label) return label;
  label = document.createElement('label');
  label.setAttribute('aria-hidden', 'true');
  label.style.cssText = 'position:fixed;left:-100px;top:-100px;width:1px;height:1px;overflow:hidden;opacity:0;pointer-events:none';
  const input = document.createElement('input');
  input.type = 'checkbox';
  input.setAttribute('switch', '');
  input.tabIndex = -1;
  label.appendChild(input);
  document.body.appendChild(label);
  return label;
}

export function haptic(kind: HapticKind = 'light'): void {
  if (!settings().haptics) return;
  const now = performance.now();
  if (now - last < 40) return;
  last = now;
  const nav = navigator as Navigator & { vibrate?: (p: number | number[]) => boolean };
  if (typeof nav.vibrate === 'function') {
    nav.vibrate(kind === 'error' ? [18, 60, 18] : kind === 'medium' ? 16 : 8);
    return;
  }
  try {
    const l = iosSwitch();
    l.click();
    if (kind === 'error') setTimeout(() => l.click(), 90);
  } catch { /* no haptics here */ }
}
