// Hindi (Devanagari) to the phonemes Kokoro's Hindi voices were trained on (espeak-ng style IPA), for Hinglish
// narration. The bundled phonemizer only knows English, so Hindi words are spelled out here by rule: Hindi is
// written almost as it is said, apart from the silent "a" (schwa deletion), nasals and stress.
// A line like "आज हम gravity समझेंगे।" is split into Hindi words (done here) and the rest (English, numbers),
// which the server sends to the English phonemizer; the same Hindi voice then says both.

const CONS = {
  'क': 'k', 'ख': 'kʰ', 'ग': 'ɡ', 'घ': 'ɡʰ', 'ङ': 'ŋ', 'च': 'ʧ', 'छ': 'ʧʰ', 'ज': 'ʤ', 'झ': 'ʤʰ', 'ञ': 'ɲ',
  'ट': 'ʈ', 'ठ': 'ʈʰ', 'ड': 'ɖ', 'ढ': 'ɖʰ', 'ण': 'ɳ', 'त': 't', 'थ': 'tʰ', 'द': 'd', 'ध': 'dʰ', 'न': 'n',
  'प': 'p', 'फ': 'pʰ', 'ब': 'b', 'भ': 'bʰ', 'म': 'm', 'य': 'j', 'र': 'ɾ', 'ल': 'l', 'ळ': 'l', 'व': 'ʋ',
  'श': 'ʃ', 'ष': 'ʃ', 'स': 's', 'ह': 'h',   // Kokoro's alphabet has no ɦ: h is the nearest it can say
  'क़': 'k', 'ख़': 'x', 'ग़': 'ɣ', 'ज़': 'z', 'ड़': 'ɽ', 'ढ़': 'ɽʰ', 'फ़': 'f', 'य़': 'j',
};
const NUKTA = { 'क': 'k', 'ख': 'x', 'ग': 'ɣ', 'ज': 'z', 'ड': 'ɽ', 'ढ': 'ɽʰ', 'फ': 'f', 'य': 'j' };
const VOWEL = { 'अ': 'ə', 'आ': 'aː', 'इ': 'ɪ', 'ई': 'iː', 'उ': 'ʊ', 'ऊ': 'uː', 'ऋ': 'ɾɪ', 'ए': 'eː', 'ऐ': 'ɛː', 'ओ': 'oː', 'औ': 'ɔː', 'ऑ': 'ɔ', 'ऍ': 'ɛ' };
const MATRA = { 'ा': 'aː', 'ि': 'ɪ', 'ी': 'iː', 'ु': 'ʊ', 'ू': 'uː', 'ृ': 'ɾɪ', 'े': 'eː', 'ै': 'ɛː', 'ो': 'oː', 'ौ': 'ɔː', 'ॉ': 'ɔ', 'ॅ': 'ɛ' };
const VIRAMA = '्', NUKTA_SIGN = '़', ANUSVARA = 'ं', CANDRA = 'ँ', VISARGA = 'ः';
// an anusvara before a stop is said as that stop's own nasal (हिंदी = hindi, संबंध = sambandh)
const PLACE = [[/^(k|ɡ|x|ɣ)/, 'ŋ'], [/^(ʧ|ʤ)/, 'ɲ'], [/^(ʈ|ɖ)/, 'ɳ'], [/^(t|d|n)/, 'n'], [/^(p|b|m)/, 'm']];
// small words said without stress, as in speech (है, का, में …)
const LIGHT = new Set(['है', 'हैं', 'का', 'की', 'के', 'को', 'में', 'से', 'पे', 'पर', 'और', 'तो', 'ही', 'भी', 'ना', 'न', 'कि', 'या', 'हो', 'था', 'थी', 'थे']);
// everyday words whose sound the rules do not reach
const WORDS = { 'यह': 'jˈɛh', 'वह': 'ʋˈoː', 'ये': 'jˈeː', 'वो': 'ʋˈoː' };

const DEVA = /[ऀ-ॿ]/;

// one Hindi word to phonemes
function word(w) {
  if (WORDS[w]) return WORDS[w];
  const ph = [];   // {c} consonant | {v, schwa, nasal}
  const chars = [...w];
  for (let i = 0; i < chars.length; i++) {
    const ch = chars[i];
    if (CONS[ch] !== undefined) {
      let c = CONS[ch];
      if (chars[i + 1] === NUKTA_SIGN) { c = NUKTA[ch] || c; i++; }
      ph.push({ c });
      const nx = chars[i + 1];
      if (MATRA[nx]) { ph.push({ v: MATRA[nx] }); i++; }
      else if (nx === VIRAMA) i++;
      else ph.push({ v: 'ə', schwa: true });
    } else if (VOWEL[ch]) ph.push({ v: VOWEL[ch] });
    else if (ch === ANUSVARA || ch === CANDRA) { const last = ph[ph.length - 1]; if (last && last.v) last.nasal = ch === CANDRA ? 'v' : 'a'; }
    else if (ch === VISARGA) ph.push({ c: 'h' });
  }
  // the silent "a": gone at the end of a word of two or more vowels (कमल = kamal), and between two single
  // consonants that each sit next to a vowel (समझना = samajhnā), checked from the right
  const vowels = ph.filter(p => p.v).length;
  if (vowels > 1 && ph.length && ph[ph.length - 1].schwa && !ph[ph.length - 1].nasal) ph.pop();
  for (let i = ph.length - 2; i >= 2; i--) {
    const p = ph[i];
    if (p.schwa && !p.nasal && ph[i - 1].c && ph[i - 2].v && ph[i + 1] && ph[i + 1].c && ph[i + 2] && ph[i + 2].v) ph.splice(i, 1);
  }
  // "a" before an h that closes its syllable sounds like e (रहता = rehtā)
  for (let i = 0; i < ph.length - 1; i++) if (ph[i].v === 'ə' && ph[i + 1].c === 'h' && !(ph[i + 2] && ph[i + 2].v)) ph[i].v = 'ɛ';
  // nasals: a stop's own nasal before a stop, otherwise a nasal vowel
  const out = [];
  for (let i = 0; i < ph.length; i++) {
    const p = ph[i];
    if (p.c) { out.push({ c: p.c }); continue; }
    const next = ph[i + 1], place = p.nasal === 'a' && next && next.c && PLACE.find(([re]) => re.test(next.c));
    if (place) { out.push({ v: p.v }); out.push({ c: place[1] }); }
    else out.push({ v: p.nasal ? p.v[0] + '\u0303' + p.v.slice(1) : p.v });
  }
  // stress (espeak writes ˈ just before the vowel): the last heavy syllable (long vowel, or closed by a
  // consonant) before the final one, else the first. Small words stay unstressed.
  if (!LIGHT.has(w)) {
    const vs = out.map((p, i) => p.v ? i : -1).filter(i => i >= 0);
    const heavy = k => { const i = vs[k], end = k + 1 < vs.length ? vs[k + 1] : out.length, n = end - i - 1; return /ː/.test(out[i].v) || (k + 1 < vs.length ? n >= 2 : n >= 1); };
    let at = 0; for (let k = vs.length - 2; k >= 0; k--) if (heavy(k)) { at = k; break; }
    if (vs.length) out[vs[at]].v = 'ˈ' + out[vs[at]].v;
  }
  return out.map(p => p.v || p.c).join('');
}

// Splits a line into pieces: {hi: phonemes} for each Hindi word, {en: text} for the rest (English, numbers),
// {p: punctuation}, which Kokoro reads as pauses. The Hindi full stop becomes a full stop.
const PUNCT = ';:,.!?—…"()“”';
function split(text) {
  // zero-width joiners only shape how a conjunct is drawn; ॐ is said "om"
  const t = String(text).replace(/[\u200c\u200d]/g, '').replace(/ॐ/g, 'ओम').replace(/[।॥]/g, '.').replace(/[०-९]/g, d => String(d.charCodeAt(0) - 0x0966));
  const pieces = [];
  // a number keeps its , and . (1,000 is "one thousand", 3.14 is "three point one four"), so it goes whole to English
  for (const m of t.matchAll(/[\u0900-\u097F]+|[;:,.!?—…"()“”]+|(?:\d+(?:[.,]\d+)+|[^\u0900-\u097F;:,.!?—…"()“”])+/g)) {
    const x = m[0];
    if (DEVA.test(x[0])) pieces.push({ hi: word(x) });
    else if (PUNCT.includes(x[0])) pieces.push({ p: x });
    else if (x.trim()) pieces.push({ en: x.trim() });
  }
  return pieces;
}
module.exports = { split, word };
