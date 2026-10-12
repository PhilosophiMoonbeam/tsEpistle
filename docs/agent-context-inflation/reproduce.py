"""Offline byte-accounting diagnostic; never starts a Wiki or calls an AI provider."""
import argparse
import json
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile

folder = Path(__file__).resolve().parent
repo = folder.parents[1]
parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("--input", type=Path, default=folder / "fixture.json")
parser.add_argument("--model", default="gemini-3.8-flash")
parser.add_argument("--output", type=Path, help="Optional metrics destination; contains no source text")
args = parser.parse_args()
bun = shutil.which("bun")
if bun is None:
    raise SystemExit("Install the repository's supported Bun version and run bun install --frozen-lockfile first.")
if not (repo / "node_modules/@ax-llm/ax").is_dir():
    raise SystemExit("Run bun install --frozen-lockfile in this checkout first.")
with tempfile.TemporaryDirectory(prefix="falcon-context-probe-") as temporary:
    prepared = subprocess.run(
        [sys.executable, str(folder / "prepare.py"), str(repo), temporary],
        check=True, capture_output=True, text=True,
    )
    subprocess.run(
        [bun, str(Path(temporary) / "probe.ts"), str(args.input.resolve()), "13", args.model],
        check=True, capture_output=True, text=True,
    )
    metrics = json.loads((Path(temporary) / "metrics.json").read_text())
    encoded = json.dumps(metrics, indent=2) + "\n"
    if args.output:
        args.output.write_text(encoded)
    sys.stdout.write(encoded)
