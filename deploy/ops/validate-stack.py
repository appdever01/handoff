import json
import pathlib
import sys

project, service, data, image, *files = sys.argv[1:]
containers = json.load(sys.stdin)
if len(containers) != 1:
    raise SystemExit("Expected exactly one deployed API container")
container = containers[0]
labels = container.get("Config", {}).get("Labels", {})
if labels.get("com.docker.compose.project") != project or labels.get("com.docker.compose.service") != service:
    raise SystemExit("Compose project or API service does not match the deployed container")
actual_files = labels.get("com.docker.compose.project.config_files", "").split(",")
normalize = lambda values: sorted(str(pathlib.Path(value).resolve()) for value in values if value)
if normalize(actual_files) != normalize(files):
    raise SystemExit("Compose files differ from the deployed stack; use the actual generated files and every override")
mounts = [mount for mount in container.get("Mounts", []) if mount.get("Destination") == "/data"]
if len(mounts) != 1 or mounts[0].get("Type") != "bind" or pathlib.Path(mounts[0]["Source"]).resolve() != pathlib.Path(data).resolve():
    raise SystemExit("Configured data directory does not match the deployed API mount")
if container.get("Config", {}).get("Image") != image:
    raise SystemExit("Configured image differs from the deployed API; review the release before maintenance")
