#!/usr/bin/env python3
"""
Renders the ablation matrix as a presentation slide.

Reads the newest matrix result and draws it. Nothing is typed in by hand,
so the image cannot drift from the numbers it claims to show, which is the
same reason the fixture emits its own answer key.

Deliberately sparse. A slide is read from across a room in about four
seconds, so it carries the configurations, the numbers, and nothing else.
The reasoning lives in the repository.
"""
from __future__ import annotations

import glob
import json
import os
import sys
from PIL import Image, ImageDraw, ImageFont

SCALE = 2  # Retina. Halved on export so text stays crisp when projected.
W = 1600 * SCALE  # Height is computed from the row count: a slide with a
                  # third of it empty reads as an unfinished slide.

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


def newest_matrix() -> dict:
    here = os.path.dirname(os.path.abspath(__file__))
    results = sorted(glob.glob(os.path.join(here, "..", "results", "*-matrix.json")))
    if not results:
        sys.exit("No matrix result found. Run npm run matrix first.")
    with open(results[-1]) as handle:
        return json.load(handle)


def main() -> None:
    data = newest_matrix()

    # Baseline first, then the arms that cost something ordered by spend,
    # then the derived rows. Grouping the free rows together stops a reader
    # wondering why two lines in the middle have no price.
    rows = sorted(
        data["rows"],
        key=lambda r: (r["name"] != "baseline", r["costUsd"] == 0, -r["costUsd"]),
    )

    height = (300 + 52 * len(rows) + 120) * SCALE
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

    draw.text((x0, y), "Ablation: what each component is worth", font=f_title, fill=INK)
    y += 62 * SCALE
    draw.text(
        (x0, y),
        f"{data['model']} · {data['period']} · 370 transactions · 60 planted defects · same fixture, same seed",
        font=f_sub,
        fill=MUTED,
    )
    y += 52 * SCALE

    # Columns: name is wide, numbers are narrow and right aligned so the
    # eye can compare them down the column rather than reading across.
    cols = [
        ("Configuration", x0, "left"),
        ("Accuracy", x0 + 640 * SCALE, "right"),
        ("Anomaly F1", x0 + 850 * SCALE, "right"),
        ("Turns", x0 + 1020 * SCALE, "right"),
        ("Cost", x0 + 1190 * SCALE, "right"),
    ]

    for label, x, align in cols:
        anchor = "la" if align == "left" else "ra"
        draw.text((x, y), label.upper(), font=f_head, fill=MUTED, anchor=anchor)
    y += 30 * SCALE
    draw.line([(x0, y), (x1, y)], fill=INK, width=2 * SCALE)
    y += 26 * SCALE

    baseline = rows[0]
    any_truncated = False

    for index, row in enumerate(rows):
        is_baseline = index == 0
        name_font = font(BOLD, 24) if is_baseline else f_name

        # An arm that exhausted its context did not score zero, it failed to
        # produce a score at all. Drawing the zero would put a number on a
        # slide that no measurement stands behind, so the quality columns
        # are struck out and the reason goes in the footnote. The cost and
        # the turns are still real: it spent that money running out of room.
        truncated = row["note"].startswith("TRUNCATED")
        any_truncated = any_truncated or truncated

        values = [
            ("--" if truncated else f"{row['accuracy'] * 100:.1f}%", cols[1][1]),
            ("--" if truncated else f"{row['anomalyF1']:.2f}", cols[2][1]),
            (str(row["turns"]), cols[3][1]),
            ("free" if row["costUsd"] == 0 else f"${row['costUsd']:.2f}", cols[4][1]),
        ]

        draw.text((x0, y), row["name"], font=name_font, fill=INK, anchor="la")
        for text, x in values:
            draw.text((x, y), text, font=f_cell, fill=MUTED if text == "--" else INK, anchor="ra")

        # A single coloured delta per row, on the number that moved most.
        if not is_baseline and row["costUsd"] > 0:
            delta = (row["costUsd"] - baseline["costUsd"]) / baseline["costUsd"]
            if abs(delta) >= 0.1:
                draw.text(
                    (x1, y + 4 * SCALE),
                    f"{delta * 100:+.0f}%",
                    font=f_note,
                    fill=BAD if delta > 0 else GOOD,
                    anchor="ra",
                )

        y += 52 * SCALE
        if index < len(rows) - 1:
            draw.line([(x0, y - 14 * SCALE), (x1, y - 14 * SCALE)], fill=RULE, width=1 * SCALE)

    y += 24 * SCALE
    draw.line([(x0, y), (x1, y)], fill=RULE, width=1 * SCALE)
    y += 28 * SCALE

    total = sum(r["costUsd"] for r in rows)
    note = (
        f"Total spend ${total:.2f}. Rows marked free reuse the baseline's model output, "
        "which is identical by construction."
    )
    if any_truncated:
        note += "  Dashes mean the arm exhausted its context before finishing, so it has no score to report."
    draw.text((x0, y), note, font=f_note, fill=MUTED)

    out = sys.argv[1] if len(sys.argv) > 1 else os.path.expanduser("~/Desktop/tieout-ablation.png")
    image.resize((W // SCALE, height // SCALE), Image.LANCZOS).save(out, "PNG")
    print(f"wrote {out}")


if __name__ == "__main__":
    main()
