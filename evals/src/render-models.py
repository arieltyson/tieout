#!/usr/bin/env python3
"""
Renders the model comparison as a presentation slide.

Reads the per-model close results and draws them, so the image cannot
drift from the numbers it claims to show. Same reasoning as
render-table.py, and it shares that file's layout so the two slides sit
together without looking like they came from different decks.

The claim under test is that the harness matters more than the model. A
cheap model inside this harness against an expensive one is the only
comparison that can support or refute it, so the cost column is not a
footnote here. It is the point.
"""
from __future__ import annotations

import glob
import json
import os
import sys
from PIL import Image, ImageDraw, ImageFont

SCALE = 2
W = 1600 * SCALE

INK = (17, 17, 20)
MUTED = (122, 126, 134)
RULE = (222, 224, 228)
PAPER = (255, 255, 255)
GOOD = (14, 122, 74)
BAD = (176, 48, 42)

FONT_DIRS = [
    "/System/Library/Fonts/Supplemental",
    "/System/Library/Fonts",
    "/Library/Fonts",
]

# Display names. The API ids carry dates and suffixes that mean nothing to
# an audience and push the column wide enough to crowd the numbers.
SHORT = {
    "claude-opus-5": "Opus 5",
    "claude-sonnet-5": "Sonnet 5",
    "claude-haiku-4-5": "Haiku 4.5",
}

# Cheapest first. The interesting reading is left to right: what does the
# extra money buy.
ORDER = ["claude-haiku-4-5", "claude-sonnet-5", "claude-opus-5"]


def font(names: list[str], size: int) -> ImageFont.FreeTypeFont:
    for name in names:
        for directory in FONT_DIRS:
            path = os.path.join(directory, name)
            if os.path.exists(path):
                return ImageFont.truetype(path, size * SCALE)
    return ImageFont.load_default()


BOLD = ["Helvetica.ttc", "Arial Bold.ttf", "Arial.ttf"]
REG = ["Helvetica.ttc", "Arial.ttf"]
MONO = ["Menlo.ttc", "Courier New.ttf"]


def short_name(model: str) -> str:
    for key, name in SHORT.items():
        if model.startswith(key):
            return name
    return model


def load_runs() -> list[dict]:
    """Newest result per model, so a re-run supersedes rather than duplicates."""
    here = os.path.dirname(os.path.abspath(__file__))
    paths = sorted(glob.glob(os.path.join(here, "..", "results", "*-close.json")))
    if not paths:
        sys.exit("No close results found. Run npm run close -- --model <id> first.")

    by_model: dict[str, dict] = {}
    for path in paths:
        with open(path) as handle:
            run = json.load(handle)
        for key in SHORT:
            if run.get("model", "").startswith(key):
                by_model[key] = run
                break

    missing = [SHORT[k] for k in ORDER if k not in by_model]
    if missing:
        sys.exit(f"No result for: {', '.join(missing)}. Run those models first.")
    return [by_model[k] for k in ORDER]


def main() -> None:
    runs = load_runs()

    height = (300 + 52 * len(runs) + 140) * SCALE
    image = Image.new("RGB", (W, height), PAPER)
    draw = ImageDraw.Draw(image)

    f_title = font(BOLD, 46)
    f_sub = font(REG, 20)
    f_head = font(BOLD, 19)
    f_cell = font(MONO, 24)
    f_name = font(REG, 24)
    f_note = font(REG, 17)

    x0, x1 = 90 * SCALE, W - 90 * SCALE
    y = 78 * SCALE

    draw.text((x0, y), "Same harness, three models", font=f_title, fill=INK)
    y += 62 * SCALE
    draw.text(
        (x0, y),
        "2026-06 · 370 transactions · 60 planted defects · same fixture, same seed, same code path",
        font=f_sub,
        fill=MUTED,
    )
    y += 52 * SCALE

    cols = [
        ("Model", x0, "left"),
        ("Accuracy", x0 + 640 * SCALE, "right"),
        ("Anomaly F1", x0 + 850 * SCALE, "right"),
        ("Turns", x0 + 1020 * SCALE, "right"),
        ("Cost", x0 + 1190 * SCALE, "right"),
    ]
    for label, x, align in cols:
        draw.text((x, y), label.upper(), font=f_head, fill=MUTED,
                  anchor="la" if align == "left" else "ra")
    y += 30 * SCALE
    draw.line([(x0, y), (x1, y)], fill=INK, width=2 * SCALE)
    y += 26 * SCALE

    # Sonnet is the configuration every published number was measured on,
    # so deltas are read against it rather than against the cheapest row.
    baseline = next(r for r in runs if r["model"].startswith("claude-sonnet-5"))
    any_truncated = False

    for index, run in enumerate(runs):
        truncated = run.get("truncated", False)
        any_truncated = any_truncated or truncated
        is_baseline = run is baseline

        accuracy = run["score"]["accuracy"]
        f1 = run["anomalies"]["overallF1"]
        cost = run["costUsd"]

        values = [
            ("--" if truncated else f"{accuracy * 100:.1f}%", cols[1][1]),
            ("--" if truncated else f"{f1:.2f}", cols[2][1]),
            (str(run["turns"]), cols[3][1]),
            (f"${cost:.2f}" if cost else "—", cols[4][1]),
        ]

        draw.text((x0, y), short_name(run["model"]),
                  font=font(BOLD, 24) if is_baseline else f_name, fill=INK, anchor="la")
        for text, x in values:
            draw.text((x, y), text, font=f_cell,
                      fill=MUTED if text == "--" else INK, anchor="ra")

        if not is_baseline and cost and baseline["costUsd"]:
            delta = (cost - baseline["costUsd"]) / baseline["costUsd"]
            draw.text((x1, y + 4 * SCALE), f"{delta * 100:+.0f}%", font=f_note,
                      fill=BAD if delta > 0 else GOOD, anchor="ra")

        y += 52 * SCALE
        if index < len(runs) - 1:
            draw.line([(x0, y - 14 * SCALE), (x1, y - 14 * SCALE)], fill=RULE, width=1 * SCALE)

    y += 24 * SCALE
    draw.line([(x0, y), (x1, y)], fill=RULE, width=1 * SCALE)
    y += 28 * SCALE

    note = ("Deterministic findings are identical across all three rows: the detectors "
            "are code, so the model never touches them.")
    if any_truncated:
        note += "  Dashes mean the run exhausted its context and has no score."
    draw.text((x0, y), note, font=f_note, fill=MUTED)

    out = sys.argv[1] if len(sys.argv) > 1 else os.path.expanduser("~/Desktop/tieout-models.png")
    image.resize((W // SCALE, height // SCALE), Image.LANCZOS).save(out, "PNG")
    print(f"wrote {out}")


if __name__ == "__main__":
    main()
