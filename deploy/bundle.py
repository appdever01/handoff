#!/usr/bin/env python3
import argparse
import gzip
import hashlib
import io
import json
import os
from pathlib import Path
import tarfile

BACKEND_FILES = (
    "package.json", "package-lock.json", "tsconfig.json", "Dockerfile",
    "Dockerfile.media", "Dockerfile.scanner", "Dockerfile.dockerignore", "clamd.conf", ".dockerignore",
)
BLOCKED = {".git", "node_modules", ".data", ".sandbox-data", ".backups", "__pycache__", "secrets", ".secrets", "data", "backups"}


def collect(root, relative, entries):
    path = root / relative
    if path.is_symlink():
        raise ValueError(f"Symbolic link excluded from release: {relative}")
    if path.name in BLOCKED or path.name in {".env", ".DS_Store", "preview_worker_secret"} or path.suffix in {".pyc", ".pem", ".key", ".p12", ".env"} or (path.name.startswith(".env.") and not path.name.endswith(".example")):
        return
    if path.is_dir():
        for child in sorted(path.iterdir(), key=lambda child: child.name):
            collect(root, child.relative_to(root), entries)
    elif path.is_file():
        entries[str(relative)] = (path.read_bytes(), 0o755 if os.access(path, os.X_OK) else 0o644)
    else:
        raise ValueError(f"Required release input missing or unsupported: {relative}")


def assemble(workspace):
    entries = {}
    for name in BACKEND_FILES:
        collect(workspace, Path("backend") / name, entries)
    for name in ("src", "packages/contracts", "deploy"):
        collect(workspace, Path("backend") / name, entries)
    for name in ("dist", "deploy"):
        collect(workspace, Path("frontend") / name, entries)
    if "frontend/dist/index.html" not in entries:
        raise ValueError("Build the frontend before creating a release")
    frontend_source = {}
    for name in ("src", "index.html", "vite.config.ts", "package.json", "package-lock.json"):
        collect(workspace, Path("frontend") / name, frontend_source)
    records = {
        name: {"sha256": hashlib.sha256(content).hexdigest(), "bytes": len(content), "mode": mode}
        for name, (content, mode) in sorted(entries.items())
    }
    source_hashes = {
        name: hashlib.sha256(content).hexdigest()
        for name, (content, _) in sorted(frontend_source.items())
    }
    manifest = json.dumps({"format": 1, "files": records, "frontendSource": source_hashes}, sort_keys=True, indent=2).encode() + b"\n"
    release = hashlib.sha256(manifest).hexdigest()[:16]
    entries["manifest.json"] = (manifest, 0o644)
    entries["release.env"] = (f"HANDOFF_RELEASE={release}\n".encode(), 0o644)
    entries["README.md"] = (entries["backend/deploy/README.md"][0], 0o644)
    return release, entries


def write_bundle(output, entries):
    with output.open("xb") as raw:
        with gzip.GzipFile(fileobj=raw, mode="wb", filename="", mtime=0) as compressed:
            with tarfile.open(fileobj=compressed, mode="w|", format=tarfile.PAX_FORMAT) as archive:
                for name, (content, mode) in sorted(entries.items()):
                    info = tarfile.TarInfo(name)
                    info.size = len(content)
                    info.mode = mode
                    info.mtime = 0
                    info.uid = info.gid = 0
                    archive.addfile(info, io.BytesIO(content))


def main():
    parser = argparse.ArgumentParser(description="Package already-built frontend and backend source without local data or credentials")
    parser.add_argument("--workspace", type=Path, default=Path(__file__).resolve().parents[2])
    parser.add_argument("--output-dir", type=Path, required=True)
    args = parser.parse_args()
    release, entries = assemble(args.workspace.resolve())
    args.output_dir.mkdir(parents=True, exist_ok=True)
    output = args.output_dir / f"handoff-{release}.tar.gz"
    write_bundle(output, entries)
    checksum = hashlib.sha256(output.read_bytes()).hexdigest()
    output.with_suffix(output.suffix + ".sha256").write_text(f"{checksum}  {output.name}\n")
    print(output.resolve())
    print(f"SHA256 {checksum}")


if __name__ == "__main__":
    main()
