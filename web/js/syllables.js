// Lyrics → syllables, one per sung note (Edit notes → Lyrics, views/lyricmode.js).
//   English: rule-based hyphenation the way songbooks print it (a-maz-ing, twin-kle, lov-ing, won-der).
//   Vietnamese: every written word is one syllable. Chinese / Japanese characters: one each.
//   A "-" typed in a word is kept as the split ("Hal-le-lu-jah"); "_" or "~" glues words onto one note ("and_the").
// syllabify(text, lang) -> [{ text, syllabic: 'single'|'begin'|'middle'|'end', line }]   line = first syllable of a text line
const VI = /[ăâđêôơưàáảãạằắẳẵặầấẩẫậèéẻẽẹềếểễệìíỉĩịòóỏõọồốổỗộờớởỡợùúủũụừứửữựỳýỷỹỵ]/i;
const CJK = /[぀-ヿ㐀-鿿豈-﫿]/;
export const isVietnamese = (t) => VI.test(t || '');
export function guessLang(text) { return isVietnamese(text) ? 'vi' : 'en'; }

const V = 'aeiouy';
const ONSETS = new Set(['bl', 'br', 'cl', 'cr', 'dr', 'fl', 'fr', 'gl', 'gr', 'pl', 'pr', 'tr', 'tw', 'wr', 'ch', 'sh', 'th', 'ph', 'wh', 'qu', 'kn',
  'thr', 'shr', 'chr', 'phr', 'spr', 'str', 'scr', 'spl', 'squ', 'sch']);
const KEEP_LEFT = ['ck', 'ng', 'x', 'gh'];
// words the rules get wrong, as sung
const EXCEPT = { every: 'ev-ery', everything: 'ev-ery-thing', everyone: 'ev-ery-one', heaven: 'heav-en', heavens: 'heav-ens', over: 'o-ver', ever: 'ev-er',
  never: 'nev-er', forever: 'for-ev-er', river: 'riv-er', very: 'ver-y', merry: 'mer-ry', many: 'man-y', any: 'an-y', only: 'on-ly', little: 'lit-tle',
  people: 'peo-ple', beautiful: 'beau-ti-ful', diamond: 'di-a-mond', quiet: 'qui-et', poem: 'po-em', lion: 'li-on', fire: 'fire', hour: 'hour',
  our: 'our', flower: 'flow-er', power: 'pow-er', shower: 'show-er', maybe: 'may-be', jesus: 'Je-sus', alleluia: 'al-le-lu-ia', hallelujah: 'hal-le-lu-jah',
  being: 'be-ing', seeing: 'see-ing', going: 'go-ing', doing: 'do-ing', crying: 'cry-ing', dying: 'dy-ing', trying: 'try-ing', flying: 'fly-ing',
  create: 'cre-ate', idea: 'i-de-a', science: 'sci-ence', world: 'world', girl: 'girl', business: 'bus-i-ness', evening: 'eve-ning', family: 'fam-i-ly',
  christmas: 'Christ-mas', listen: 'lis-ten', often: 'of-ten', mountain: 'moun-tain', fountain: 'foun-tain', wonderful: 'won-der-ful' };

const isV = (w, i) => {
  const c = w[i];
  if (!c) return false;
  if (c === 'y') return i > 0 && !V.includes(w[i - 1]) && !(i + 1 < w.length && 'aeiou'.includes(w[i + 1]));
  if (c === 'u' && i > 0 && w[i - 1] === 'q') return false; // qu: a consonant
  return 'aeiou'.includes(c);
};

// [start, end) of each vowel group (nucleus) of a lower-case word
function nuclei(w) {
  const g = [], n = w.length;
  for (let i = 0; i < n; i++) {
    if (!isV(w, i)) continue;
    const last = g[g.length - 1];
    if (last && last[1] === i) {
      const pair = w[i - 1] + w[i];
      // two vowels said apart (li-on, di-a-mond, cru-el, Glo-ri-a) unless -tion / -cious / -sian…
      const apart = (/^(ia|io|iu|ua|uo|eo)$/.test(pair) && !(i >= 2 && /[tsc]i[aou]/.test(w.slice(i - 2, i + 1))))
        || (pair === 'ue' && i + 1 < n && !V.includes(w[i + 1]) && !/[gq]$/.test(w[i - 2] || ''));
      if (!apart) { last[1] = i + 1; continue; }
    }
    g.push([i, i + 1]);
  }
  if (g.length < 2) return g;
  const end = g[g.length - 1];
  if (/[^aeiouy]le$/.test(w) && end[0] === n - 1) { g.pop(); g.push([n - 2, n - 1]); } // lit-tle, ta-ble: the l carries it
  else if (/[^aeiouy]les$/.test(w) && end[0] === n - 2) { g.pop(); g.push([n - 3, n - 2]); } // ta-bles
  else if (end[0] === n - 1 && end[1] === n && w[n - 1] === 'e' && !V.includes(w[n - 2])) g.pop(); // a silent e (love, grace)
  else if (end[0] === n - 2 && end[1] === n - 1 && /e[sd]$/.test(w)) { // -es / -ed that add no sound (comes, loved) — not ro-ses, want-ed
    const pre = w.slice(0, n - 2);
    if (!(w.endsWith('ed') ? /([td]|[^aeiou][rl])$/.test(pre) : /([sxzcg]|ch|sh)$/.test(pre))) g.pop();
  }
  return g;
}

// where to cut the consonants between two vowel groups (index into the word)
function cut(w, a, b) { // consonants are w[a..b)
  const c = w.slice(a, b);
  if (!c.length) return a; // vowels said apart
  if (c.length === 1) return 'xwy'.includes(c) ? b : a; // a-maz-ing, but ex-it, flow-er, play-er
  for (let k = 0; k < c.length - 1; k++) if (c[k] === c[k + 1] && c[k] !== 'h') return a + k + 1; // lit-tle, sum-mer
  for (const kl of KEEP_LEFT) if (c.startsWith(kl) && c.length > kl.length) return a + kl.length; // pick-ing, sing-er
  if (c.length === 2) return ONSETS.has(c) ? a : a + 1; // ta-ble? (a-gree, fa-ther) / sis-ter
  for (let k = 0; k < c.length; k++) if (ONSETS.has(c.slice(k))) return a + k; // hun-dred, an-gry
  return b - 1;
}

function base(word) {
  const w = word.toLowerCase();
  const g = nuclei(w);
  if (g.length < 2) return [word];
  const out = [];
  let s = 0;
  for (let k = 1; k < g.length; k++) {
    const at = cut(w, g[k - 1][1], g[k][0]);
    if (at > s) { out.push(word.slice(s, at)); s = at; }
  }
  out.push(word.slice(s));
  return out.filter(Boolean);
}

const SUFFIX = ['ing', 'ness', 'ful', 'less', 'ment', 'ly', 'est'];
function english(word) {
  const lower = word.toLowerCase();
  if (EXCEPT[lower] !== undefined && EXCEPT[lower]) {
    const parts = EXCEPT[lower].split('-');
    let s = 0;
    return parts.map((p) => { const x = word.slice(s, s + p.length); s += p.length; return x; });
  }
  for (const suf of SUFFIX) {
    if (!lower.endsWith(suf) || lower.length <= suf.length + 1) continue;
    const stem = word.slice(0, -suf.length);
    if (!nuclei(stem.toLowerCase()).length) continue;
    if (suf === 'est' && !/[^aeiou]{1,2}$/.test(stem.toLowerCase())) continue;
    // the stem keeps its letters (lov-ing: the e already gone); a doubled consonant goes with -ing (run-ning)
    const st = stem.toLowerCase();
    if (suf === 'ing' && st.length > 2 && st.at(-1) === st.at(-2) && !'aeiouls'.includes(st.at(-1))) return [...base(stem.slice(0, -1)), stem.slice(-1) + word.slice(-suf.length)];
    return [...base(stem), word.slice(-suf.length)];
  }
  return base(word);
}

// one written word (letters plus the punctuation around it) -> its syllables
export function wordSyllables(raw, lang = 'en') {
  if (raw.includes('-') && /[^-]-[^-]/.test(raw)) return raw.split('-').filter(Boolean); // typed splits win
  if (CJK.test(raw)) return [...raw].reduce((a, ch) => { if (CJK.test(ch) || !a.length) a.push(ch); else a[a.length - 1] += ch; return a; }, []);
  if (lang === 'vi' || isVietnamese(raw)) return [raw];
  const m = raw.match(/^([^\p{L}']*)([\p{L}']+)([^\p{L}']*)$/u);
  if (!m) return [raw];
  const parts = english(m[2]);
  parts[0] = m[1] + parts[0];
  parts[parts.length - 1] += m[3];
  return parts;
}

export const syllabicOf = (k, n) => (n === 1 ? 'single' : k === 0 ? 'begin' : k === n - 1 ? 'end' : 'middle');

export function syllabify(text, lang = 'auto') {
  const L = lang === 'auto' ? guessLang(text) : lang;
  const out = [];
  for (const line of String(text || '').split(/\n/)) {
    let first = true;
    for (const w of line.split(/\s+/).filter((x) => x && /[\p{L}\p{N}]/u.test(x))) {
      const parts = wordSyllables(w.replace(/[_~]/g, ' '), L);
      parts.forEach((p, k) => { out.push({ text: p, syllabic: syllabicOf(k, parts.length), line: first }); first = false; });
    }
  }
  return out;
}

