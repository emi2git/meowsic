// Verified: a person checked this score and it is complete. Backed by the tag "Verified" (on = the item has it;
// the tag is made when missing — store.setTags / POST /tags/set). The badge sits next to the title in the score
// view; a small mark shows beside verified items in the library list. Each toggle is an Activities row with Undo.
import { store } from '../store.js';
import { toast } from '../ui.js';

export const VERIFIED = 'Verified';
export const isVerified = (it) => !!it?.tags?.includes(VERIFIED);

const SEAL = '<svg class="ic" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 2.5l2.4 1.8 3-.2.9 2.9 2.4 1.8-1 2.8 1 2.8-2.4 1.8-.9 2.9-3-.2L12 21.5l-2.4-1.8-3 .2-.9-2.9-2.4-1.8 1-2.8-1-2.8 2.4-1.8.9-2.9 3 .2z"/><path d="M8.5 12l2.5 2.5 4.5-5"/></svg>';
const inner = (on) => `${on ? '<b aria-hidden="true">✓</b>' : SEAL}<span>Verified</span>`;
const tip = (on) => (on ? 'Verified by a person: the score is complete (tap to unmark)' : 'Not verified yet: tap once a person has checked the whole score');

// the small list mark (library rows); tags are otherwise hidden in lists
export const verifiedMark = (it) => (isVerified(it) ? '<span class="verified-mark" title="Verified: checked by a person" aria-label="Verified">✓</span>' : '');

export function verifiedBadgeHtml(it) {
  const on = isVerified(it);
  return `<button class="verified-badge${on ? ' on' : ''}" id="it-verified" aria-pressed="${on}" title="${tip(on)}" aria-label="Verified">${inner(on)}</button>`;
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
    btn.title = tip(on);
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
