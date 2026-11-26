"""Print the model versions in the model repo (models/index.json, see hw/models.py).

    python scripts/list_models.py              # a table, newest first
    python scripts/list_models.py --json       # the index as it is
    python scripts/list_models.py --rebuild    # rebuild the index from the folders (writes!)

Needs HF_TOKEN (read access; --rebuild needs write access).  --local DIR reads a
local folder that stands in for the repo instead.
"""
import argparse
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from hw import models, progress  # noqa: E402


def table(index: dict) -> str:
    rows = [f"{'id':<38} {'created (UTC)':<20} {'lines':>5} {'rounds':>6} {'best':>4} {'score':>8}  note"]
    for m in index.get("models", []):
        rows.append(f"{m['id']:<38} {m.get('created', ''):<20} {m.get('lines') or '':>5} {m.get('rounds') or '':>6} "
                    f"{m.get('best_round') or '':>4} {'' if m.get('score') is None else m['score']:>8}  {m.get('note') or ''}")
    if len(rows) == 1:
        rows.append("(no versions yet)")
    return "\n".join(rows)


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--repo", default="handwriting-fable-model")
    ap.add_argument("--local", default=None, help="a local folder in place of the model repo")
    ap.add_argument("--json", action="store_true")
    ap.add_argument("--rebuild", action="store_true", help="rebuild models/index.json from the version folders")
    args = ap.parse_args(argv)
    if args.local:
        hub = progress.LocalHub(args.local)
    else:
        hub = progress.HfHub(os.environ.get("HF_TOKEN") or os.environ.get("HUGGINGFACE_ACCESS_TOKEN"), model=args.repo)
    if args.rebuild:
        index = models.rebuild_index(hub)
    else:
        index = models.build_index(hub)          # what the folders say (the stored index may lag a hand edit)
    print(json.dumps(index, ensure_ascii=False, indent=1) if args.json else table(index))


if __name__ == "__main__":
    main()
