#!/usr/bin/env python3
"""Copy selected MIT skill bodies and record local Pitako edits.

Expected environment:
  PSTACK_CHECKOUT    official pstack plugin tree (cursor/plugins/pstack)
  CAVEMAN_CHECKOUT   JuliusBrussee/caveman checkout
  PONYTAIL_CHECKOUT  DietrichGebert/ponytail checkout
"""

from __future__ import annotations

import os
import shutil
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def required_checkout(name: str) -> Path:
    value = os.environ.get(name)
    if not value:
        raise SystemExit(f"{name} is required")
    path = Path(value)
    if not path.is_dir():
        raise SystemExit(f"{name} is not a directory: {path}")
    return path


PITAKO_FOOTER = """
## Pitako

Load this principle only when its trigger applies. Do not keep it in context for unrelated work.
When the question is structural, use CodeGraph or LSP before reading large files.
"""

PRINCIPLES = [
    "principle-foundational-thinking",
    "principle-model-the-domain",
    "principle-boundary-discipline",
    "principle-prove-it-works",
    "principle-fix-root-causes",
    "principle-guard-the-context-window",
    "principle-subtract-before-you-add",
    "principle-minimize-reader-load",
    "principle-type-system-discipline",
    "principle-sequence-verifiable-units",
    "principle-encode-lessons-in-structure",
    "principle-make-operations-idempotent",
    "principle-exhaust-the-design-space",
    "principle-outcome-oriented-execution",
    "principle-redesign-from-first-principles",
    "principle-build-the-lever",
    "principle-migrate-callers-then-delete-legacy-apis",
    "principle-separate-before-serializing-shared-state",
    "principle-experience-first",
]


def strip_disable(text: str) -> str:
    return "".join(line for line in text.splitlines(keepends=True) if not line.startswith("disable-model-invocation:"))


def write_skill(dest: Path, text: str) -> None:
    dest.parent.mkdir(parents=True, exist_ok=True)
    dest.write_text(text if text.endswith("\n") else text + "\n")


def vendor_principles(pstack: Path) -> None:
    dest_root = ROOT / "skills" / "principles"
    if dest_root.exists():
        shutil.rmtree(dest_root)
    for name in PRINCIPLES:
        source = pstack / "skills" / name / "SKILL.md"
        text = strip_disable(source.read_text())
        text = text.replace(
            "Per the [Laziness Protocol](../principle-laziness-protocol/SKILL.md), build the smallest script that does or proves the job, never a framework.",
            "Build the smallest script that does or proves the job, never a framework. Ponytail governs how small that script stays.",
        )
        if name == "principle-guard-the-context-window":
            text = text.replace(
                'description: "Apply when context is filling up: large outputs, long files, repeated reads, fan-out planning. Route bulk to subagents; keep summaries in the main thread, not raw payloads."',
                'description: "Apply when context is filling up: large outputs, long files, repeated reads, or wide exploration. Prefer targeted CodeGraph/LSP queries and summaries over dumping raw trees."',
            )
            text = text.replace(
                "- **Isolate large payloads.** Route verbose outputs, screenshots, and large documents to subagents. The main context gets summaries, not raw data.",
                "- **Isolate large payloads.** Prefer a targeted CodeGraph or LSP query over reading a whole tree. Keep summaries, not raw dumps.",
            )
        text = text.rstrip() + "\n" + PITAKO_FOOTER
        write_skill(dest_root / name / "SKILL.md", text)


def vendor_caveman(caveman: Path) -> None:
    note = """
## Pitako default

Use **lite** unless the user asks for another level. Keep architectural explanations in full sentences.
Do not load this skill and the full Ponytail body in the same turn.
Do not use full, ultra, or wenyan unless the user asks.
Persisted writing (code, comments, commits, docs, PR text) stays normal prose.

"""
    for name in ("caveman", "investigate-first"):
        source = caveman / "skills" / name / "SKILL.md"
        text = source.read_text()
        parts = text.split("---", 2)
        if len(parts) < 3:
            raise SystemExit(f"unexpected frontmatter in {source}")
        body = parts[2].lstrip("\n")
        if name == "caveman":
            body = body.replace(
                "Default: **full**. Switch: `/caveman lite|full|ultra|wenyan-lite|wenyan-full|wenyan-ultra|off`.",
                "Pitako default: **lite**. Upstream default is full; do not use it unless the user asks. Switch only if asked: `/skill:caveman` with lite|full|ultra.",
            )
        write_skill(ROOT / "skills" / name / "SKILL.md", f"---{parts[1]}---\n{note}{body}")


def vendor_optional_language(pstack: Path) -> None:
    src = pstack / "skills" / "typescript-best-practices"
    dest = ROOT / "skills" / "language" / "typescript-best-practices"
    if dest.exists():
        shutil.rmtree(dest)
    shutil.copytree(src, dest, ignore=shutil.ignore_patterns(".DS_Store"))
    skill = dest / "SKILL.md"
    skill.write_text(strip_disable(skill.read_text()))


def vendor_verification_example(pstack: Path) -> None:
    src = pstack / "skills" / "create-verification-skill" / "references"
    dest = ROOT / "skills" / "practical" / "create-verification-skill" / "references"
    if dest.exists():
        shutil.rmtree(dest)
    shutil.copytree(src, dest)


def vendor_licenses(pstack: Path, caveman: Path, ponytail: Path) -> None:
    dest = ROOT / "docs" / "licenses"
    dest.mkdir(parents=True, exist_ok=True)
    shutil.copy2(pstack / "LICENSE", dest / "pstack-LICENSE")
    shutil.copy2(caveman / "LICENSE", dest / "caveman-LICENSE")
    shutil.copy2(ponytail / "LICENSE", dest / "ponytail-LICENSE")


if __name__ == "__main__":
    pstack = required_checkout("PSTACK_CHECKOUT")
    caveman = required_checkout("CAVEMAN_CHECKOUT")
    ponytail = required_checkout("PONYTAIL_CHECKOUT")
    vendor_principles(pstack)
    vendor_caveman(caveman)
    vendor_optional_language(pstack)
    vendor_verification_example(pstack)
    vendor_licenses(pstack, caveman, ponytail)
    print("vendored principles, caveman, language skill, licenses")
