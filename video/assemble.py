"""Turn frames_cap/ (variable-rate screencast) into a silent 1080p30 H.264 MP4 + cue sheet.
Usage: python3 assemble.py  ->  out/MARG_demo_silent.mp4, out/CUES.md"""
import json, pathlib, subprocess

HERE = pathlib.Path(__file__).parent
CAP = HERE / "frames_cap"
OUT = HERE / "out"
OUT.mkdir(exist_ok=True)
FPS = 30

idx = json.loads((CAP / "index.json").read_text())
frames = sorted(idx["frames"], key=lambda f: f["t"])
start = 0.5  # beat clock lead-in
total = idx["total"] - start

# constant-rate list: for each output frame, the latest captured frame at that moment
lst, j = [], 0
for k in range(round(total * FPS)):
    t = start + k / FPS
    while j + 1 < len(frames) and frames[j + 1]["t"] <= t:
        j += 1
    lst.append(frames[j]["file"])
with open(CAP / "list.txt", "w") as fh:
    for f in lst:
        fh.write(f"file '{f}'\nduration {1 / FPS:.6f}\n")
    fh.write(f"file '{lst[-1]}'\n")

mp4 = OUT / "MARG_demo_silent.mp4"
subprocess.run(["ffmpeg", "-y", "-loglevel", "error", "-f", "concat", "-safe", "0", "-i", str(CAP / "list.txt"),
                "-vf", f"fps={FPS},format=yuv420p", "-c:v", "libx264", "-preset", "slow", "-crf", "16",
                "-tune", "animation", "-movflags", "+faststart", "-r", str(FPS), str(mp4)], check=True)

lines = {
    "hook": "पैंतीस बार। Kurla के एक 500 meter road को ...",
    "anecdote": "आपको पता ही है ये क्या scene होता है ...",
    "intro": "इसलिए मैंने बनाया MARG ...",
    "money": "पूरे monsoon में तेरह करोड़ खर्च हुए ...",
    "fairness": "लेकिन मैं कोई हवा में blame नहीं लगा रहा ...",
    "nextrupee": "अब काम की बात: अगला रुपया कहाँ लगना चाहिए? ...",
    "action": "और ये सब सिर्फ dashboard नहीं है ...",
    "close": "एक road पर पैंतीस बार repair normal नहीं हो सकता ...",
}
fmt = lambda s: f"{int(s // 60)}:{s % 60:04.1f}"
rows = [f"| {fmt(m['start'] - start)} | {fmt(m['start'] - start + m['len'])} | {m['len']:.1f} s | {m['name']} | {lines[m['name']]} |" for m in idx["marks"]]
(OUT / "CUES.md").write_text("# MARG demo: cue sheet\n\nSilent 1080p30 cut. Record one paragraph of VOICEOVER.md per row; "
                             "if a paragraph runs long or short, send the audio and the cut gets re-timed to it.\n\n"
                             "| In | Out | Length | Beat | Paragraph starts |\n|---|---|---|---|---|\n" + "\n".join(rows) + "\n")
dur = subprocess.run(["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", str(mp4)], capture_output=True, text=True).stdout.strip()
print(mp4, dur, "s", f"{len(frames)} source frames")
