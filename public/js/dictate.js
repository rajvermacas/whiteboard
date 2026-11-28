// Speak a question: hold E on the board (or hold 🎙️ Speak) and talk; letting go sends what Hex heard to the chat,
// the same as typing it and pressing Enter. Hex records and transcribes with its selected model (see hex.js).
const mic = { state: 'idle', started: null, via: '' };   // idle → listening → transcribing → idle
let micNoteTimer = 0;
function micNote(t, err) {
  const n = $('#micNote'); clearTimeout(micNoteTimer);
  n.textContent = t; n.classList.toggle('err', !!err); n.hidden = !t;
  if (t && err !== undefined) micNoteTimer = setTimeout(() => { n.hidden = true; }, err ? 6000 : 3000);
}
function micShow(state) {
  mic.state = state;
  const b = $('#micBtn'); b.classList.toggle('listening', state === 'listening'); b.setAttribute('aria-pressed', state === 'listening');
  micNote(state === 'listening' ? `🎙️ Listening… let go of ${mic.via} to send` : state === 'transcribing' ? 'Transcribing…' : '');
}
async function dictation(act) {
  const res = await fetch('/api/dictation/' + act, { method: 'POST' });
  const j = await res.json();
  if (!res.ok) throw new Error((j.error && j.error.message) || 'HTTP ' + res.status);
  return j;
}
function dictateDown(via) {
  if (mic.state !== 'idle') return;
  mic.via = via; micShow('listening'); dlog('user: hold', via, '→ dictate');
  mic.started = dictation('start');
  mic.started.catch(e => { micShow('idle'); micNote(e.message, true); dlog('dictate: start failed', e.message); });
}
async function dictateUp() {
  if (mic.state !== 'listening') return;
  micShow('transcribing');
  try {
    await mic.started;
    const { text } = await dictation('stop');
    micShow('idle');
    if (!text) { micNote("Didn't hear anything", false); return; }
    dlog('dictate: heard', text);
    input.value = input.value.trim() ? input.value.trim() + ' ' + text : text;
    $('#composer').requestSubmit();
  } catch (e) {
    if (mic.state !== 'idle') { micShow('idle'); micNote(e.message, true); }
    dlog('dictate: failed', e.message);
  }
}
// the key or the window went away mid-recording (⌘-Tab, a dialog): nothing is sent
function dictateCancel(why) {
  if (mic.state !== 'listening') return;
  micShow('idle'); micNote('Cancelled', false); dlog('dictate: cancelled', why);
  mic.started.then(() => dictation('cancel')).catch(e => micNote(e.message, true));
}
document.addEventListener('keyup', e => { if (e.code === 'KeyE' || e.key === 'e' || e.key === 'E') dictateUp(); });
window.addEventListener('blur', () => dictateCancel('window lost focus'));
const micBtn = $('#micBtn');
micBtn.addEventListener('pointerdown', e => { if (e.button !== 0) return; e.preventDefault(); micBtn.setPointerCapture(e.pointerId); dictateDown('the button'); });
micBtn.addEventListener('pointerup', () => dictateUp());
micBtn.addEventListener('pointercancel', () => dictateCancel('pointer cancelled'));
micBtn.addEventListener('click', e => e.preventDefault());
