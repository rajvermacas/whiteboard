# Maya 2 Native (Maya Research, Apache-2.0) on Apple Silicon through mlx-audio: a natural Hindi / Hinglish voice.
# server.js starts this once and keeps it running (the model takes a while to load). It reads one JSON request per
# line on stdin, {"id", "text", "voice", "lang"}, and answers one JSON line on stdout: {"id", "sr", "pcm"} with the
# audio as base64 float32 samples, or {"id", "error"}. The first line it prints is {"ready": true, "voices": [...]}.
import base64, json, os, sys

out = sys.stdout
sys.stdout = sys.stderr   # the library's own prints must not mix with the answers

import numpy as np
from mlx_audio.tts.utils import load

model = load(os.environ.get("MAYA_MODEL", "aruntemme/maya2-native-mlx-8bit"))
next(model.generate("नमस्ते।", voice="Ahana", lang_code="hi"))   # warm up, so the first real line is not slow
out.write(json.dumps({"ready": True, "voices": list(model.voices)}) + "\n"); out.flush()

for line in sys.stdin:
    req = {}
    try:
        req = json.loads(line)
        results = list(model.generate(req["text"], voice=req["voice"], lang_code=req["lang"]))
        sr = results[0].sample_rate if results else 24000
        audio = np.concatenate([np.asarray(r.audio, dtype=np.float32) for r in results]) if results else np.zeros(sr // 10, dtype=np.float32)
        out.write(json.dumps({"id": req.get("id"), "sr": sr, "pcm": base64.b64encode(audio.astype("<f4").tobytes()).decode()}) + "\n")
    except Exception as e:
        out.write(json.dumps({"id": req.get("id"), "error": str(e)[:300]}) + "\n")
    out.flush()
