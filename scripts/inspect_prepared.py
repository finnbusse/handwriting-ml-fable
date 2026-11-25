"""Diagnostic: run the preparation and draw composed lines next to real lines."""
import json, pickle, numpy as np
from hw import sources, dataset, prep
from hw.ink import contact_sheet, draw
import matplotlib; matplotlib.use("Agg"); import matplotlib.pyplot as plt

base = json.load(open("artifacts/base/stats.json"))
raw = sources.load_all("data_cache", fetch=False)
raw, _ = dataset.apply_exclusions(raw, dataset.load_exclusions())
inks, report = dataset.calibrate(raw, base)
pickle.dump((inks, report), open("runs/check/prepared.pkl", "wb"))
words = [i for i in inks if i.kind == "word"]; lines = [i for i in inks if i.kind == "line"]
ppc = np.array([len(i) / max(len(i.text.replace(' ', '')), 1) for i in inks])
print("inks", len(inks), "words", len(words), "lines", len(lines), "| points/char median", round(float(np.median(ppc)), 1),
      "| points/ink p50/p95/max", int(np.median([len(i) for i in inks])), int(np.percentile([len(i) for i in inks], 95)), max(len(i) for i in inks))
gm, gs = dataset.measure_gaps(lines); print("word gap (xh): median %.2f sd %.2f" % (gm, gs))
# normalised size check: height of words above the baseline
for src in sorted({i.source for i in inks}):
    L = [i for i in inks if i.source == src]
    top = np.array([-i.points[:, 1].min() for i in L]); wpc = np.array([np.ptp(i.points[:, 0]) / max(len(i.text), 1) for i in L])
    print(f"  {src:26s} n={len(L):4d} top above baseline p10/50/90 = {np.percentile(top,10):.2f}/{np.median(top):.2f}/{np.percentile(top,90):.2f}  width/char median {np.median(wpc):.2f}  xh_px p10/50/90 = {np.percentile([i.meta['xh_px'] for i in L],10):.1f}/{np.median([i.meta['xh_px'] for i in L]):.1f}/{np.percentile([i.meta['xh_px'] for i in L],90):.1f}")
comp = dataset.LineComposer([w for w in words if w.source in ("handwriting-v1", "v3testing", "handwritten-numbers-codex")], gm, gs, seed=3)
sheet = lines[:5] + comp.fixed(9, seed=7)
fig, axes = plt.subplots(len(sheet), 1, figsize=(15, 1.15 * len(sheet)))
for k, (ax, ink) in enumerate(zip(axes, sheet)):
    draw(ax, ink, title=("ECHT: " if k < 5 else "ZUSAMMENGESETZT: ") + ink.text, lw=1.0)
    x0, _, x1, _ = ink.bbox()
    ax.plot([x0, x1], [0, 0], color="tab:red", lw=0.5); ax.plot([x0, x1], [1, 1], color="tab:blue", lw=0.5)
fig.tight_layout(); fig.savefig("runs/check/composed.png", dpi=70); plt.close(fig)
