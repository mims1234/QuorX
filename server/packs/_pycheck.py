# QuorX's Python check before the final reply (see python.js). Run in a project folder, it prints one line per
# problem as "path:line: message": syntax errors in every .py file, as the project's own Python sees them, and, when
# the project already has ruff or pyflakes, names that are used but never defined. It writes nothing (no .pyc files,
# no fixes). QuorX keeps only the lines about files the reply changed.
import os
import shutil
import subprocess
import sys
import warnings

SKIP = {'.git', '.hg', '.venv', 'venv', 'env', '__pycache__', 'node_modules', '.quorx', '.tox', '.nox', '.mypy_cache',
        '.pytest_cache', '.ruff_cache', 'build', 'dist', 'site-packages', '.eggs'}
VENVS = ('.venv', 'venv', 'env')
MAX_FILES, MAX_BYTES = 3000, 2_000_000
# pyflakes messages that are errors (the program fails when it gets there), not style.
PYFLAKES_ERRORS = {'UndefinedName', 'UndefinedLocal', 'UndefinedExport', 'DuplicateArgument', 'ReturnOutsideFunction',
                   'YieldOutsideFunction', 'ContinueOutsideLoop', 'BreakOutsideLoop', 'DefaultExceptNotLast',
                   'TwoStarredExpressions', 'TooManyExpressionsInStarredAssignment', 'ForwardAnnotationSyntaxError'}
# ruff's rules for the same: syntax errors, undefined names, and the like (flake8's usual "fatal" set).
RUFF_SELECT = 'E9,F63,F7,F82'


def venv_python(root):
    for name in VENVS:
        exe = os.path.join(root, name, 'Scripts', 'python.exe') if os.name == 'nt' else os.path.join(root, name, 'bin', 'python')
        if os.path.isfile(os.path.join(root, name, 'pyvenv.cfg')) and os.path.isfile(exe):
            return exe
    return None


def py_files(root):
    out = []
    for d, dirs, files in os.walk(root):
        dirs[:] = sorted(x for x in dirs if x not in SKIP and not x.startswith('.') and not x.endswith('.egg-info'))
        for f in sorted(files):
            if f.endswith(('.py', '.pyw')):
                out.append(os.path.relpath(os.path.join(d, f), root))
                if len(out) >= MAX_FILES:
                    return out
    return out


def syntax(root, files):
    problems, ok = [], []
    warnings.simplefilter('ignore')  # invalid escapes and the like are warnings, not errors
    for rel in files:
        try:
            with open(os.path.join(root, rel), 'rb') as fh:
                src = fh.read(MAX_BYTES + 1)
            if len(src) > MAX_BYTES:
                continue
            compile(src, rel, 'exec', dont_inherit=True)
            ok.append(rel)
        except SyntaxError as e:  # also IndentationError and TabError
            problems.append(f'{rel}:{e.lineno or 1}: {type(e).__name__}: {e.msg}')
        except (ValueError, OSError) as e:
            problems.append(f'{rel}:1: {e}')
    return problems, ok


def ruff_exe(root):
    venv = venv_python(root)
    if venv:
        exe = os.path.join(os.path.dirname(venv), 'ruff.exe' if os.name == 'nt' else 'ruff')
        if os.path.isfile(exe):
            return exe
    configured = any(os.path.isfile(os.path.join(root, f)) for f in ('ruff.toml', '.ruff.toml'))
    try:
        with open(os.path.join(root, 'pyproject.toml'), encoding='utf-8') as fh:
            configured = configured or '[tool.ruff' in fh.read()
    except OSError:
        pass
    return shutil.which('ruff') if configured else None


def lint(root, files):
    ruff = ruff_exe(root)
    if ruff:
        r = subprocess.run([ruff, 'check', '--no-fix', '--quiet', '--select', RUFF_SELECT, '--output-format', 'concise', '.'],
                           cwd=root, capture_output=True, text=True, timeout=120)
        lines = []
        for line in r.stdout.splitlines():
            # path:line:col: CODE message
            parts = line.split(':', 3)
            if len(parts) == 4 and parts[1].strip().isdigit():
                lines.append(f'{parts[0]}:{parts[1]}: {parts[3].strip()}')
        return lines
    try:
        import ast
        from pyflakes import checker
    except ImportError:
        return []
    lines = []
    for rel in files:
        try:
            with open(os.path.join(root, rel), 'rb') as fh:
                tree = ast.parse(fh.read(), rel)
        except (SyntaxError, ValueError, OSError):
            continue
        for m in checker.Checker(tree, filename=rel).messages:
            if type(m).__name__ in PYFLAKES_ERRORS:
                lines.append(f'{rel}:{m.lineno}: {m.message % m.message_args}')
    return lines


def main():
    root = os.getcwd()
    # The project's own interpreter decides what is valid (a venv on Python 3.9 has no match statement).
    venv = venv_python(root)
    if venv and not os.environ.get('QX_PYCHECK_INNER') and os.path.normcase(os.path.abspath(sys.executable)) != os.path.normcase(os.path.abspath(venv)):
        sys.exit(subprocess.run([venv, '-I', __file__], env=dict(os.environ, QX_PYCHECK_INNER='1')).returncode)
    files = py_files(root)
    problems, ok = syntax(root, files)
    problems += lint(root, ok)
    for p in problems:
        print(p)
    sys.exit(1 if problems else 0)


main()
