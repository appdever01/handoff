#!/usr/bin/env python3
import argparse
import copy
import json
import os
from pathlib import Path
import subprocess


def image_only(config):
    result = copy.deepcopy(config)
    result.pop("name", None)
    for service in result["services"].values():
        service.pop("build", None)
        service["pull_policy"] = "never"
    for kind in ("networks", "volumes"):
        for resource in result.get(kind, {}).values():
            if not resource.get("external"):
                resource.pop("name", None)
    return result


def main():
    parser = argparse.ArgumentParser(description="Write an image-only Coolify Compose file after building this release on its target Docker host")
    parser.add_argument("--env-file", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    compose = Path(__file__).resolve().parent / "compose.yaml"
    result = subprocess.run(
        ["docker", "compose", "--env-file", str(args.env_file.resolve()), "-f", str(compose), "config", "--format", "json"],
        check=True, stdout=subprocess.PIPE, text=True,
    )
    config = image_only(json.loads(result.stdout))
    fd = os.open(args.output, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, "w") as output:
        json.dump(config, output, indent=2, sort_keys=True)
        output.write("\n")
    print(f"Private image-only Compose written to {args.output.resolve()}")


if __name__ == "__main__":
    main()
