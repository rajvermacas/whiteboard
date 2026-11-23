/* Whiteboard Teacher — the order questions are answered in.
 * Every question belongs to the answer that was playing when it was asked (its parent): a side question, a
 * double-click and a popup "draw it" alike. That makes a tree, answered depth first:
 *  - questions with the same parent are answered first asked, first answered: a later one never overtakes an earlier
 *    one, even when its answer is ready first;
 *  - going deeper is eager: the parent's next question takes over at the next sentence as soon as its answer is
 *    ready (a double-click / "draw it" then goes down into its own tab, and everything asked there belongs to it);
 *  - while the next question is not ready, the teacher carries on with the parent (the current topic), or, if that is
 *    finished, waits for it;
 *  - coming back is lazy: the teacher goes back up to the answer a question was asked in (the parent tab, for a tab)
 *    only once that question and everything asked inside it have been answered; there the same cycle goes on.
 * chat.js keeps the mechanics (setting answers aside, taking over at a sentence, going back); this decides what is next. */
'use strict';
let askSeq = 0;   // the order questions were asked in

// the answer the teacher is in: the one playing (or that just finished), else the set-aside one it goes back to
function currentNode() {
  if (liveTurn && !forks.some(f => f.turn === liveTurn)) return liveTurn;
  return parked ? parked.turn : null;
}
// the next question asked inside an answer (the earliest asked that is still waiting); null = top level
function headOf(parent) {
  let best = null;
  for (const t of pendingHeld) if (!t.dropped && (t.parentTurn || null) === parent && (!best || (t.seq || 0) < (best.seq || 0))) best = t;
  return best;
}
// may this answer take over at the next sentence? Only the next question of the answer the teacher is in
const mayTakeOver = t => (t.parentTurn || null) === currentNode() && headOf(t.parentTurn || null) === t;
const releasable = t => !!(t && t.ready && t.held && t.held.length && !t.waitResume);
const isParkedWithWork = t => !!(t && forks.some(f => f.turn === t && forkLeft(f)));

// When nothing is playing: what comes next. {release: t} | {resume: true} (carry on with the set-aside answer on top)
// | {wait: t} (stay here until t's answer is ready) | null (nothing left)
function nextStep() {
  let x = currentNode();
  for (let guard = 0; guard < 60; guard++) {
    const h = headOf(x);
    if (releasable(h)) return { release: h };
    if (x && isParkedWithWork(x)) return { resume: true };   // the current topic (set-aside answers above it with nothing left are skipped)
    if (h) { const off = offChainReady(); return off ? { release: off } : { wait: h }; }
    if (!x) break;
    x = x.parentTurn || null;   // everything inside x is answered: back up to the answer it was asked in
  }
  if (parked && forkLeft(parked)) return { resume: true };   // e.g. an answer set aside by looking at another tab
  const any = [...pendingHeld].filter(releasable).sort((a, b) => (a.seq || 0) - (b.seq || 0))[0];   // its parent is gone
  return any ? { release: any } : null;
}
// a ready question whose parent is neither the answer the teacher is in nor one it will go back up to (its branch
// was left, e.g. by asking a new question): it is not waiting for anything, so it may go while the teacher waits
function offChainReady() {
  const chain = new Set(); for (let x = currentNode(); x && !chain.has(x); x = x.parentTurn || null) chain.add(x);
  const inForks = t => forks.some(f => f.turn === t);
  return [...pendingHeld].filter(t => releasable(t) && t.parentTurn && !chain.has(t.parentTurn) && !inForks(t.parentTurn))
    .sort((a, b) => (a.seq || 0) - (b.seq || 0))[0] || null;
}
const tabOfTurnSafe = t => (t && t.tab && tabs.has(t.tab)) ? t.tab : TAB_MAIN;
// the answer the teacher is in changed (one took over, or it went back): its next question, if ready, comes in at
// the next sentence
function kickHeads() {
  const h = headOf(currentNode());
  if (h && h.ready && h.held && !h.releasing) requestRelease(h);
}
// an answer that goes away (dropped, or replaced by a steer) hands the questions asked inside it to `to`
function reparentQuestions(from, to) {
  for (const t of pendingHeld) if (t.parentTurn === from) t.parentTurn = to || null;
}
