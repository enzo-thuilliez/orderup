#!/usr/bin/env python3
"""Check that the README's architecture diagram still matches the code.

Each code-backed node of a mermaid diagram carries a comment naming the path it stands for:

    ```mermaid
    flowchart LR
        api["API"] --> llm["LLM layer"]
        %% api: src/app/main.py
        %% llm: src/app/llm.py
    ```

Mermaid ignores `%%` lines, so GitHub renders the diagram unchanged. This script fails when a
linked path no longer exists or a link names a node that is not in the diagram, so a rename
or a deleted module cannot leave the README describing code that is gone.

    python3 .github/scripts/check-diagram.py [README.md ...]
    python3 .github/scripts/check-diagram.py --self-test
"""

import re
import sys
import tempfile
from pathlib import Path

BLOCK = re.compile(r"```mermaid\n(.*?)```", re.DOTALL)
LINK = re.compile(r"^\s*%%\s*([A-Za-z0-9_-]+)\s*:\s*(\S+)\s*$", re.MULTILINE)


def check(readme: Path) -> list[str]:
    """Return one message per broken link in `readme` (empty when everything is fine)."""
    root = readme.parent
    problems = []
    for block in BLOCK.findall(readme.read_text(encoding="utf-8")):
        body = LINK.sub("", block)
        for node, target in LINK.findall(block):
            if not re.search(rf"(?<![\w-]){re.escape(node)}(?![\w-])", body):
                problems.append(f"{readme}: link for node '{node}', which is not in the diagram")
            if not (root / target).exists():
                problems.append(f"{readme}: node '{node}' points at {target}, which does not exist")
    return problems


def self_test() -> None:
    """Check the checker on three small READMEs."""
    with tempfile.TemporaryDirectory() as tmp:
        root = Path(tmp)
        (root / "src").mkdir()
        (root / "src" / "api.py").write_text("")
        readme = root / "README.md"
        fence = "```"
        readme.write_text(
            f'{fence}mermaid\nflowchart LR\n  api["API"] --> db[("DB")]\n'
            f"  %% api: src/api.py\n{fence}\n"
        )
        assert check(readme) == [], check(readme)
        readme.write_text(
            f'{fence}mermaid\nflowchart LR\n  api["API"]\n'
            f"  %% api: src/gone.py\n  %% ghost: src/api.py\n{fence}\n"
        )
        problems = check(readme)
        assert len(problems) == 2, problems
        assert "src/gone.py" in problems[0], problems
        assert "ghost" in problems[1], problems
        readme.write_text("# No diagram\n")
        assert check(readme) == []
    print("self-test passed")


def main(argv: list[str]) -> int:
    """Check the given READMEs (default README.md); print GitHub annotations."""
    if argv == ["--self-test"]:
        self_test()
        return 0
    problems = []
    for name in argv or ["README.md"]:
        path = Path(name)
        if path.is_file():
            problems += check(path)
    for problem in problems:
        print(f"::error::{problem}")
    if not problems:
        print("README diagrams match the code.")
    return 1 if problems else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
