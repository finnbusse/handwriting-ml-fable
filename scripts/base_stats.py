"""Measure the base model's own handwriting: x-height (model units per x-height),
point density and word spacing.  These constants calibrate the writer's data."""
import json, sys, numpy as np, torch
from hw.sampling import Synthesizer
from hw import prep
from hw.ink import contact_sheet

TEXTS = """The quick brown fox jumps over the lazy dog
A man came into the room and sat down
She said that it would be no trouble at all
There were more than seven of them in the garden
He went on to make some comment about it
We have never seen such a summer in our lives
and some of them are not even very good ones
it was a cold morning, some sun, no wind
no one can come in or out of this old house
our numbers were now one man more or less
never mind, we can do some more over in a moment
on a warm summer evening we saw a narrow river""".splitlines()

def main(out="runs/check"):
    torch.set_num_threads(4)
    syn = Synthesizer.load("artifacts/base")
    inks = []
    for seed in range(6):
        inks += syn.write(TEXTS, bias=0.6, seed=seed)
    good = [i for i in inks if i.meta["finished"] and 12 < len(i) / max(len(i.text), 1) < 45]
    print(f"samples {len(inks)}, usable {len(good)}")
    geo, steps, ppc, lines = [], [], [], []
    for ink in good:
        a, b, size = prep.baseline(ink)
        geo.append(prep.letter_heights(ink, a, b))
        steps.append(prep.pen_down_steps(ink.points))
        ppc.append(len(ink) / len(ink.text))
        lines.append((ink, a, b))
    texts = [ink.text for ink, _, _ in lines]
    xhs = [prep.fit_xheight(h, t, 2.4) for h, t in zip(geo, texts)]     # same estimator as hw.dataset.prepare
    ratio = float(np.median([np.median(h[h > 1.6 * x]) / x for h, x in zip(geo, xhs) if (h > 1.6 * x).any()]))
    xh = float(np.median(xhs)); asc = ratio * xh
    st = np.concatenate(steps)
    res = dict(xh_model=xh, asc_over_xh=asc / xh, step_median_xh=float(np.median(st) / xh),
               step_p10_xh=float(np.quantile(st, .1) / xh), step_p90_xh=float(np.quantile(st, .9) / xh),
               points_per_char=float(np.median(ppc)), usable=len(good), total=len(inks))
    print(json.dumps(res, indent=1))
    # visual check of the estimator
    import matplotlib; matplotlib.use("Agg"); import matplotlib.pyplot as plt
    fig, axes = plt.subplots(6, 1, figsize=(14, 7))
    for ax, (ink, a, b) in zip(axes, lines[:6]):
        from hw.ink import draw
        draw(ax, ink, title=ink.text)
        x0, _, x1, _ = ink.bbox()
        for off, c in ((0, "tab:red"), (-xh, "tab:blue"), (-asc, "tab:green")):
            ax.plot([x0, x1], [-(a * x0 + b + off), -(a * x1 + b + off)], color=c, lw=0.7)
    fig.tight_layout(); fig.savefig(f"{out}/base_guides.png", dpi=75); plt.close(fig)
    with open("artifacts/base/stats.json", "w") as f:
        json.dump(res, f, indent=1)

if __name__ == "__main__":
    main()
