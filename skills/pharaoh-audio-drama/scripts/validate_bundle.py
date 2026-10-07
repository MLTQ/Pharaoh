#!/usr/bin/env python3
"""Validate a portable skill bundle; no third-party dependencies or writes.
Run after editing and before packaging. This is a privacy/link smoke check,
not proof that every CLI example or deployment platform has been exercised.
"""
import ast
import pathlib
import re
import sys

ROOT = pathlib.Path(__file__).resolve().parents[1]


def main():
    issues = []
    files = sorted(p for p in ROOT.rglob('*')
                   if p.is_file() and '.git' not in p.parts
                   and '__pycache__' not in p.parts and p.suffix in ('.md', '.py', '.fountain'))
    # These patterns reject machine-specific absolute roots, embedded UUIDs,
    # and fixed character IDs. Variable-based paths and relative files are fine.
    patterns = [r'/home/[^\s/]+', r'/Users/[^\s/]+', r'/run/media/',
                r'~/(?:Code|AudioDramas|pharaoh-projects|pharaoh-models)',
                r'\bCHAR_[0-9A-Fa-f]{6,}\b',
                r'\b[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}\b']
    for file in files:
        text = file.read_text(encoding='utf-8')
        if file.suffix == '.py':
            try:
                ast.parse(text)
            except SyntaxError as exc:
                issues.append(f'{file.relative_to(ROOT)}: syntax error: {exc}')
        if file.name == 'validate_bundle.py':
            continue  # its rejection patterns intentionally spell forbidden roots
        for pattern in patterns:
            for match in re.finditer(pattern, text):
                issues.append(f'{file.relative_to(ROOT)}: nonportable token {match.group()}')
        paths = set(re.findall(r'`((?:references|scripts)/[^`\s]+)`', text))
        for target in paths:
            if not (ROOT / target).is_file():
                issues.append(f'{file.relative_to(ROOT)}: missing referenced file {target}')
        for target in re.findall(r'\]\(([^)]+)\)', text):
            if re.match(r'^[a-zA-Z][a-zA-Z0-9+.-]*:', target) or target.startswith('#'):
                continue
            path = target.split('#', 1)[0]
            if path and not (file.parent / path).exists():
                issues.append(f'{file.relative_to(ROOT)}: broken local link {target}')
    for required in ['SKILL.md', 'README.md', 'references/source-performance-contract.md',
                     'scripts/probe_sofalizer.py']:
        if not (ROOT / required).is_file():
            issues.append(f'missing required file: {required}')
    if issues:
        print('\n'.join(issues))
        return 1
    print(f'PASS: {len(files)} Markdown/Python/Fountain files; portable path scan, local references, Python syntax.')
    return 0


if __name__ == '__main__':
    sys.exit(main())
