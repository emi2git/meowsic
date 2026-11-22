// Mock sheet-music pages, drawn as SVG so the UI has something realistic to show
// without shipping anyone's scans. Deterministic per (title, page).

function rng(seed) {
  let h = 2166136261;
  for (const c of seed) h = Math.imul(h ^ c.charCodeAt(0), 16777619);
  return () => {
    h += 0x6d2b79f5;
    let t = h;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

export function sheetSvg(title, page = 1, pages = 1, { artist = '' } = {}) {
  const r = rng(title + '#' + page);
  const W = 850, H = 1100;
  const paper = ['#fffdf7', '#fbf8ef', '#fffef9', '#f8f5ec'][Math.floor(r() * 4)];
  let g = `<rect width="${W}" height="${H}" fill="${paper}"/>`;
  let top = 90;
  if (page === 1) {
    g += `<text x="${W / 2}" y="78" text-anchor="middle" font-family="Georgia,serif" font-size="34" fill="#222">${esc(title)}</text>`;
    if (artist) g += `<text x="${W - 70}" y="118" text-anchor="end" font-family="Georgia,serif" font-size="16" font-style="italic" fill="#444">${esc(artist)}</text>`;
    top = 150;
  }
  const systems = page === 1 ? 5 : 6;
  const sysH = (H - top - 70) / systems;
  for (let s = 0; s < systems; s++) {
    const y0 = top + s * sysH;
    for (const [staff, off] of [['t', 0], ['b', 68]]) {
      const y = y0 + off;
      for (let l = 0; l < 5; l++) g += `<line x1="70" x2="${W - 60}" y1="${y + l * 9}" y2="${y + l * 9}" stroke="#333" stroke-width="1"/>`;
      g += `<text x="74" y="${y + (staff === 't' ? 34 : 22)}" font-family="serif" font-size="${staff === 't' ? 46 : 30}" fill="#222">${staff === 't' ? '𝄞' : '𝄢'}</text>`;
    }
    g += `<line x1="70" x2="70" y1="${y0}" y2="${y0 + 68 + 36}" stroke="#333" stroke-width="2"/>`;
    g += `<path d="M62 ${y0} q-10 26 0 52 q-10 26 0 52" fill="none" stroke="#333" stroke-width="3"/>`;
    const bars = 4;
    const bw = (W - 60 - 120) / bars;
    for (let b = 0; b < bars; b++) {
      const bx = 120 + b * bw;
      g += `<line x1="${bx + bw}" x2="${bx + bw}" y1="${y0}" y2="${y0 + 104}" stroke="#333" stroke-width="1.2"/>`;
      if (r() > 0.45) g += `<text x="${bx + 6}" y="${y0 - 12}" font-family="Helvetica,Arial" font-size="13" font-weight="bold" fill="#333">${['C', 'G', 'Am', 'F', 'Dm', 'Em', 'G7', 'E7'][Math.floor(r() * 8)]}</text>`;
      const n = 2 + Math.floor(r() * 4);
      for (let i = 0; i < n; i++) {
        const nx = bx + 20 + (i * (bw - 30)) / n;
        const tr = y0 + 36 - Math.floor(r() * 9) * 4.5;
        const filled = r() > 0.25;
        g += `<ellipse cx="${nx}" cy="${tr}" rx="5.6" ry="4" transform="rotate(-20 ${nx} ${tr})" fill="${filled ? '#222' : 'none'}" stroke="#222" stroke-width="1.4"/>`;
        g += `<line x1="${nx + 5}" x2="${nx + 5}" y1="${tr}" y2="${tr - 28}" stroke="#222" stroke-width="1.2"/>`;
        const bb = y0 + 68 + 36 - Math.floor(r() * 8) * 4.5;
        g += `<ellipse cx="${nx}" cy="${bb}" rx="5.6" ry="4" transform="rotate(-20 ${nx} ${bb})" fill="#222"/>`;
        g += `<line x1="${nx - 5}" x2="${nx - 5}" y1="${bb}" y2="${bb + 26}" stroke="#222" stroke-width="1.2"/>`;
      }
    }
    if (r() > 0.6) g += `<text x="${130}" y="${y0 + 60}" font-family="Helvetica" font-size="11" font-style="italic" fill="#444">la la la la</text>`;
  }
  if (pages > 1) g += `<text x="${W / 2}" y="${H - 30}" text-anchor="middle" font-family="Georgia" font-size="14" fill="#555">${page}</text>`;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}">${g}</svg>`;
}

const cache = new Map();
export function sheetUrl(title, page, pages, opts) {
  const k = title + '|' + page + '|' + pages;
  if (!cache.has(k)) cache.set(k, 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(sheetSvg(title, page, pages, opts)));
  return cache.get(k);
}
