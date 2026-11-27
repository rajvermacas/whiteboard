/* Images the learner pastes, drops or picks for the chat: they wait as thumbnails above the box and go with the next
 * message, so the teacher can teach from them. Each is shrunk to at most IMG_MAX px a side (JPEG) before sending; the
 * chat (and the saved session) keeps only a small thumbnail, while the full picture stays in memory so follow-up
 * questions in this visit still show it to the model. */
const IMG_MAX = 1600, IMG_LIMIT = 4, THUMB_MAX = 220;
let pastedImages = [];                 // [{ url, thumb }] waiting for the next message
const fullImages = new Map();          // thumb data URL -> full data URL (this visit only)

function loadImage(src) {
  return new Promise((ok, fail) => { const im = new Image(); im.onload = () => ok(im); im.onerror = () => fail(new Error('not an image')); im.src = src; });
}
function shrink(im, max, quality) {
  const k = Math.min(1, max / Math.max(im.naturalWidth, im.naturalHeight));
  const cv = document.createElement('canvas');
  cv.width = Math.max(1, Math.round(im.naturalWidth * k)); cv.height = Math.max(1, Math.round(im.naturalHeight * k));
  const g = cv.getContext('2d'); g.fillStyle = '#fff'; g.fillRect(0, 0, cv.width, cv.height);   // transparent PNGs on white
  g.drawImage(im, 0, 0, cv.width, cv.height);
  return cv.toDataURL('image/jpeg', quality);
}
async function addImageFile(file) {
  if (!file || !/^image\//.test(file.type)) return false;
  if (pastedImages.length >= IMG_LIMIT) { flashImgNote(`Up to ${IMG_LIMIT} images per message.`); return true; }
  const src = URL.createObjectURL(file), gen0 = imgGen;
  try {
    const im = await loadImage(src);
    if (gen0 !== imgGen) return true;   // the lesson changed while it decoded
    const url = shrink(im, IMG_MAX, 0.88), thumb = shrink(im, THUMB_MAX, 0.8);
    fullImages.set(thumb, url);
    pastedImages.push({ url, thumb });
    dlog('image added', `${im.naturalWidth}×${im.naturalHeight}`, Math.round(url.length * 0.75 / 1024) + 'KB');
    renderImgTray();
  } catch (e) { flashImgNote('That file could not be read as an image.'); dlog('image failed', String(e)); }
  finally { URL.revokeObjectURL(src); }
  return true;
}
function addImageFiles(files) {
  const imgs = [...(files || [])].filter(f => f && /^image\//.test(f.type));
  imgs.forEach(f => addImageFile(f));
  return imgs.length > 0;
}
// takes the waiting images for a message being sent (and clears the tray)
function takeImages() {
  const out = pastedImages; pastedImages = []; renderImgTray();
  for (const p of out) sentThumbs.add(p.thumb);
  return out;
}

// leaving a lesson (new session, switch, delete): nothing pending carries over. Pictures already sent stay for the visit
// (follow-ups and the thumbnails' full view); only the unsent ones are let go. imgGen drops an image still decoding.
let imgGen = 0;
const sentThumbs = new Set();           // thumbs already sent (the same picture can be attached again and dropped unsent)
const freeFull = p => { if (!sentThumbs.has(p.thumb)) fullImages.delete(p.thumb); };
function clearAttachments() {
  imgGen++;
  pastedImages.forEach(freeFull);
  pastedImages = []; renderImgTray();
  inkSinceAsk.clear(); showAttach(false); renderChips();
}

// a data: URL cannot be opened as a page of its own, so the picture goes into a blank tab
function showImage(url) {
  const w = window.open('', '_blank'); if (!w) return;
  w.document.title = 'Image'; w.document.body.style.cssText = 'margin:0;background:#111;display:flex;min-height:100vh;align-items:center;justify-content:center';
  const im = w.document.createElement('img'); im.src = url; im.style.cssText = 'max-width:100%;max-height:100vh'; w.document.body.appendChild(im);
}

let imgNoteTimer = 0;
function flashImgNote(t) {
  const n = $('#imgNote'); n.textContent = t; n.hidden = false;
  clearTimeout(imgNoteTimer); imgNoteTimer = setTimeout(() => { n.hidden = true; }, 3000);
}
function renderImgTray() {
  const tray = $('#imgTray'), list = $('#imgList');
  list.textContent = '';
  pastedImages.forEach((p, i) => {
    const d = document.createElement('div'); d.className = 'imgItem';
    const im = document.createElement('img'); im.src = p.thumb; im.alt = `image ${i + 1}`;
    const x = document.createElement('button'); x.type = 'button'; x.textContent = '✕'; x.title = "Don't send this image";
    x.onclick = () => { freeFull(p); pastedImages.splice(i, 1); renderImgTray(); input.focus({ preventScroll: true }); };
    d.append(im, x); list.appendChild(d);
  });
  tray.hidden = !pastedImages.length;
  if (pastedImages.length && !input.value.trim()) input.placeholder = 'Ask about the image, or just press Send';
  else if (!pastedImages.length && input.placeholder.startsWith('Ask about the image')) input.placeholder = 'Ask about…';
}

// paste (⌘V) in the chat box: images are taken, text pastes as usual
input.addEventListener('paste', e => {
  const items = [...((e.clipboardData && e.clipboardData.items) || [])].filter(it => it.kind === 'file' && /^image\//.test(it.type));
  if (!items.length) return;
  e.preventDefault();
  items.forEach(it => addImageFile(it.getAsFile()));
});
// paste with the board focused (e.g. right after sending, when the keys go to the board) attaches too
document.addEventListener('paste', e => {
  if (e.target === input || e.target.closest && e.target.closest('input,textarea,[contenteditable]')) return;
  const files = [...((e.clipboardData && e.clipboardData.files) || [])];
  if (addImageFiles(files)) e.preventDefault();
});
// drop an image file on the chat panel
const chatPane = $('#composer').parentElement;
chatPane.addEventListener('dragover', e => { if ([...e.dataTransfer.types].includes('Files')) { e.preventDefault(); chatPane.classList.add('dropping'); } });
chatPane.addEventListener('dragleave', e => { if (!chatPane.contains(e.relatedTarget)) chatPane.classList.remove('dropping'); });
chatPane.addEventListener('drop', e => {
  chatPane.classList.remove('dropping');
  if (!e.dataTransfer.files.length) return;
  e.preventDefault();
  addImageFiles(e.dataTransfer.files);
});
// 📎 button: pick image files
$('#imgBtn').onclick = () => $('#imgFile').click();
$('#imgFile').onchange = e => { addImageFiles(e.target.files); e.target.value = ''; input.focus({ preventScroll: true }); };
