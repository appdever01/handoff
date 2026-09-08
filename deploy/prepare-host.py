#!/usr/bin/env python3
import os
from pathlib import Path
import secrets
import stat
import sys


def private_directory(value):
    path = Path(value)
    if not path.is_absolute() or len(path.parts) < 4 or ".." in path.parts:
        raise ValueError("Choose an absolute, dedicated directory")
    for parent in [path, *path.parents]:
        if parent.is_symlink():
            raise ValueError("Private directories cannot traverse symbolic links")
    path.mkdir(parents=True, exist_ok=True, mode=0o700)
    os.chown(path, 1000, 1000)
    path.chmod(0o700)
    return path


def main():
    if os.geteuid() != 0 or len(sys.argv) != 3:
        raise SystemExit("Run as root: prepare-host.py DATA_DIR SECRETS_DIR")
    data, directory = (Path(value) for value in sys.argv[1:])
    if data == directory or data in directory.parents or directory in data.parents:
        raise SystemExit("Data and secret directories must be separate")
    data = private_directory(sys.argv[1])
    directory = private_directory(sys.argv[2])
    token = directory / "preview_worker_secret"
    if token.is_symlink():
        raise SystemExit("Secret cannot be a symbolic link")
    if not token.exists():
        fd = os.open(token, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o400)
        with os.fdopen(fd, "w") as output:
            output.write(secrets.token_urlsafe(48) + "\n")
    if not token.is_file():
        raise SystemExit("Existing worker secret must be a regular file")
    value = token.read_text().strip()
    if not 32 <= len(value) <= 256 or any(not 33 <= ord(char) <= 126 for char in value):
        raise SystemExit("Existing worker secret is invalid; it was not replaced")
    os.chown(token, 1000, 1000)
    token.chmod(0o400)
    socket = Path("/var/run/docker.sock")
    info = socket.stat()
    if not stat.S_ISSOCK(info.st_mode):
        raise SystemExit("Docker socket is not available")
    print(f"Private directories ready. HANDOFF_DOCKER_GID={info.st_gid}")


if __name__ == "__main__":
    main()
