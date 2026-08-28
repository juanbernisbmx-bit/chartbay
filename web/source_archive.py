"""Build the Corresponding Source archive offered by the web interface."""
from __future__ import annotations

import gzip
import io
import os
import subprocess
import tarfile
from functools import lru_cache
from pathlib import Path


_EXCLUDED_PARTS = {
    ".git",
    ".claude",
    ".venv",
    "venv",
    "node_modules",
    "__pycache__",
    ".vite",
    "cache",
    "informes",
    "worktrees",
}
_EXCLUDED_NAMES = {"chartbay.db", "credentials.json", "secrets.json"}
_EXCLUDED_SUFFIXES = {".pyc", ".db", ".db-shm", ".db-wal", ".key", ".pem"}


def _safe_source_file(root: Path, relative: Path) -> bool:
    if relative.is_absolute() or ".." in relative.parts:
        return False
    if any(part in _EXCLUDED_PARTS for part in relative.parts):
        return False
    if relative.name in _EXCLUDED_NAMES or relative.name.startswith(".env"):
        return False
    if any(relative.name.endswith(suffix) for suffix in _EXCLUDED_SUFFIXES):
        return False
    path = root / relative
    return path.is_file() and not path.is_symlink()


def _source_files(root: Path) -> list[Path]:
    """List versioned source files while excluding local state and credentials."""
    try:
        result = subprocess.run(
            ["git", "ls-files", "--cached", "-z"],
            cwd=root,
            check=True,
            capture_output=True,
        )
        candidates = [Path(raw.decode("utf-8")) for raw in result.stdout.split(b"\0") if raw]
    except (OSError, subprocess.CalledProcessError, UnicodeDecodeError):
        # Some deployment platforms omit .git from the runtime image. Walking
        # the checkout keeps the source offer working there; the same explicit
        # exclusions still prevent local state and credentials from leaking.
        candidates = [path.relative_to(root) for path in root.rglob("*")]
    return sorted(relative for relative in candidates if _safe_source_file(root, relative))


@lru_cache(maxsize=1)
def build_source_archive(root: Path) -> bytes:
    """Return a deterministic tar.gz of the source running this deployment."""
    root = root.resolve()
    compressed = io.BytesIO()
    with gzip.GzipFile(fileobj=compressed, mode="wb", mtime=0) as gzip_file:
        with tarfile.open(fileobj=gzip_file, mode="w") as archive:
            for relative in _source_files(root):
                path = root / relative
                payload = path.read_bytes()
                info = tarfile.TarInfo(f"chartbay-source/{relative.as_posix()}")
                info.size = len(payload)
                info.mtime = 0
                info.uid = info.gid = 0
                info.uname = info.gname = ""
                info.mode = 0o755 if os.access(path, os.X_OK) else 0o644
                archive.addfile(info, io.BytesIO(payload))
    return compressed.getvalue()
