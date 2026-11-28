// Speak a question with Hex (the macOS dictation app) and its selected model, e.g. Parakeet Unified English.
// The board drives the running Hex through its CLI: `hex dictation start` records with Hex's own microphone setup,
// `hex dictation stop --print` returns the transcript instead of pasting it. Hex must be running; nothing stands in for it.
const { execFile } = require('child_process');

const HEX = process.env.HEX_CLI || '/Applications/Hex.app/Contents/MacOS/hex';
const STOP_MS = 60000;   // transcribing a long question; longer means Hex is stuck

function run(args, timeout = 10000) {
  return new Promise((resolve, reject) => {
    execFile(HEX, args, { timeout }, (err, stdout, stderr) => {
      if (err && typeof err.code !== 'number') return reject(new Error(err.code === 'ENOENT' ? `Hex CLI not found at ${HEX} (set HEX_CLI)` : String(err.message || err)));
      resolve({ code: err ? err.code : 0, stdout: String(stdout), stderr: String(stderr) });
    });
  });
}
// a refused or failed command: Hex's own message (its --json reply, or stderr)
function failure(r) {
  if (r.code === 3) return new Error('Hex is not running — open Hex and try again');
  let msg = r.stderr.trim() || r.stdout.trim();
  try { const j = JSON.parse(r.stdout); if (j.message) msg = j.message; } catch {}
  return new Error('Hex: ' + (msg || 'exit ' + r.code));
}

async function start() {
  const r = await run(['dictation', 'start', '--json']);
  if (r.code !== 0) throw failure(r);
}
// the transcript, or '' when Hex heard no speech (its exit code 4)
async function stop() {
  const r = await run(['dictation', 'stop', '--print'], STOP_MS);
  if (r.code === 4) return '';
  if (r.code !== 0) throw failure(r);
  return r.stdout.trim();
}
async function cancel() {
  const r = await run(['dictation', 'cancel', '--json']);
  if (r.code !== 0) throw failure(r);
}

module.exports = { start, stop, cancel };
