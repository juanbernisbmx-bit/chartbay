"""Un único escritor por base, tanto para la importación como para el temporizador."""
import fcntl
from contextlib import contextmanager
from pathlib import Path


@contextmanager
def database_lock(directory: Path):
    directory.mkdir(parents=True, exist_ok=True)
    with (directory / ".escritura.lock").open("a") as handle:
        try:
            fcntl.flock(handle, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            raise RuntimeError("La base ya tiene otra importación o actualización en curso") from None
        try:
            yield
        finally:
            fcntl.flock(handle, fcntl.LOCK_UN)
