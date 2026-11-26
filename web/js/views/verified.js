// Verified: a person checked this score and it is complete. Backed by the tag "Verified" (on = the item has it;
// the tag is made when missing — store.setTags / POST /tags/set). The badge sits next to the title in the score
// view. Quiet when verified, amber when not: verified scores show no mark in the library list, unverified scores a
// small amber dot ("Not verified"). Each toggle is an Activities row with Undo.
import { store } from '../store.js';
import { toast } from '../ui.js';

export const VERIFIED = 'Verified';
export const isVerified = (it) => !!it?.tags?.includes(VERIFIED);

// icon-only round toggle (like the score toggles #sc-chords / #sc-names): off = amber seal outline, on = quiet grey seal + check
const SEAL_PATH = 'M12 2.5l2.4 1.8 3-.2.9 2.9 2.4 1.8-1 2.8 1 2.8-2.4 1.8-.9 2.9-3-.2L12 21.5l-2.4-1.8-3 .2-.9-2.9-2.4-1.8 1-2.8-1-2.8 2.4-1.8.9-2.9 3 .2z';
const inner = (on) => `<svg class="ic" viewBox="0 0 24 24" aria-hidden="true"><path class="seal" d="${SEAL_PATH}"/>${on ? '<path class="tick" d="M8.5 12l2.5 2.5 4.5-5"/>' : ''}</svg>`;
const label = (on) => (on ? 'Verified' : 'Not verified');

// the small list mark (library rows; tags are otherwise hidden in lists): only on scores that are NOT verified
export const verifiedMark = (it) => (it?.kind === 'score' && !isVerified(it) ? '<span class="unverified-mark" role="img" title="Not verified" aria-label="Not verified"></span>' : '');

export function verifiedBadgeHtml(it) {
  const on = isVerified(it);
  return `<button class="tg-btn verified-badge${on ? ' on' : ''}" id="it-verified" aria-pressed="${on}" title="${label(on)}" aria-label="${label(on)}">${inner(on)}</button>`;
}

// returns draw(): call it when the store changes (undo from Activities, another device)
export function wireVerified(btn, id) {
  let shown = null;
  const draw = () => {
    const on = isVerified(store.get(id));
    if (on === shown) return;
    shown = on;
    btn.classList.toggle('on', on);
    btn.setAttribute('aria-pressed', String(on));
    btn.innerHTML = inner(on);
    btn.title = label(on);
    btn.setAttribute('aria-label', label(on));
  };
  btn.onclick = () => {
    const on = !isVerified(store.get(id));
    store.setTags([id], on ? [VERIFIED] : [], on ? [] : [VERIFIED]);
    draw();
    toast(on ? 'Marked verified' : 'No longer verified');
  };
  draw();
  return draw;
}
