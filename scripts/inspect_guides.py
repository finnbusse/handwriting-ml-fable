"""Diagnostic: estimate baseline / x-height per session and draw check sheets."""
import collections, numpy as np
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))   # the repo root, for "hw"

from hw import sources, prep
from hw.ink import draw
import matplotlib; matplotlib.use("Agg"); import matplotlib.pyplot as plt

raw = sources.load_all("data_cache", fetch=False)
inks = [c for c in (prep.clean(i) for i in raw) if c is not None]
print("loaded", len(raw), "clean", len(inks))
sess = collections.defaultdict(list)
for i in inks: sess[(i.source, i.meta.get("session",""))].append(i)
rows, est = [], {}
for key, L in sorted(sess.items()):
    hs = []
    for i in L:
        a, b, size = prep.baseline(i); est[i.id] = (a, b)
        hs.append(prep.top_heights(i, a, b))
    hs = np.concatenate(hs) if hs else np.array([])
    xh, asc = prep.session_xheight(hs)
    rows.append((key, len(L), xh, asc))
    for i in L: i.meta["xh_session"] = xh
by_src = collections.defaultdict(list)
for key, n, xh, asc in rows: by_src[key[0]].append((n, xh, asc))
for s, v in by_src.items():
    n = np.array([a for a,_,_ in v]); xh = np.array([b for _,b,_ in v]); asc = np.array([c for _,_,c in v])
    print(f"{s:26s} sessions={len(v):2d} n/sess med={np.median(n):4.0f} min={n.min():3d} | xh px: {np.round(xh,1).tolist()} | asc/xh: {np.round(asc/xh,2).tolist()}")
for s in by_src:
    L = [i for i in inks if i.source == s]
    hs = np.concatenate([prep.top_heights(i, *est[i.id]) for i in L])
    xh, asc = prep.session_xheight(hs)
    print(f"  pooled {s:26s} xh={xh:.1f} asc/xh={asc/xh:.2f}")
rng = np.random.default_rng(0)
srcs = ["handwriting-test","handwriting-test-v2","handwriting-v1","v3testing","handwritten-numbers-codex","v2testing"]
fig, axes = plt.subplots(6, 8, figsize=(22, 9))
for r, s in enumerate(srcs):
    L = [i for i in inks if i.source == s]
    for c, k in enumerate(rng.choice(len(L), 8, replace=False)):
        ink = L[k]; ax = axes[r, c]; a, b = est[ink.id]; xh = ink.meta["xh_session"]
        draw(ax, ink, title=f"{ink.text} ({s[:14]})")
        x0, _, x1, _ = ink.bbox()
        for off, col in ((0, "tab:red"), (-xh, "tab:blue")):
            ax.plot([x0, x1], [-(a*x0+b+off), -(a*x1+b+off)], color=col, lw=0.8)
fig.tight_layout(); fig.savefig("runs/check/user_guides_words.png", dpi=62); plt.close(fig)
L = [i for i in inks if i.source == "handwriting-gpt6.1sol"]
fig, axes = plt.subplots(9, 2, figsize=(20, 11))
for ax, ink in zip(axes.ravel(), L):
    a, b = est[ink.id]; xh = ink.meta["xh_session"]
    draw(ax, ink, title=ink.text, lw=1.0)
    x0, _, x1, _ = ink.bbox()
    for off, col in ((0, "tab:red"), (-xh, "tab:blue")):
        ax.plot([x0, x1], [-(a*x0+b+off), -(a*x1+b+off)], color=col, lw=0.8)
for ax in axes.ravel()[len(L):]: ax.axis("off")
fig.tight_layout(); fig.savefig("runs/check/user_guides_lines.png", dpi=62); plt.close(fig)
