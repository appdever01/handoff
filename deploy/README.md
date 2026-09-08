# Handoff prelaunch server package

This package serves the frontend and API at one HTTPS origin through Coolify. It creates no cloud resources and starts no payments by default. `HANDOFF_RELEASE_STAGE=preview` requires checkout to remain off. The separately authorized `acceptance` stage may use configured test networks; mainnet is unavailable.

The API runs once, as UID 1000, with a private persistent `/data` bind mount. It has no Docker socket or Docker CLI. A separate authenticated preview worker can launch only the fixed isolated media image. Only that worker receives the host socket; it has no original-data mount. The socket still gives this worker host-level Docker authority if compromised, so keep the service private and the VPS dedicated. Media jobs have no network, no host mounts, a read-only filesystem, and CPU/memory/process limits. ClamAV is private and keeps definitions in a persistent named volume; its upstream supervisor starts as root and clamd drops to the configured `clamav` user.

The gateway runs as UID 1000 on port 8080. There are no published ports in the main Compose file. Coolify terminates TLS and routes the selected hostname to `gateway:8080`. Do not expose the API, scanner, worker, or Caddy port directly to the Internet. Caddy trusts the private Coolify proxy chain, parses client addresses from right to left, and sends only the resolved address to the API.

A reasonable initial host has 4 CPUs, 8 GB RAM, Docker Engine with Compose v2, and sufficient encrypted storage for originals, previews, database, and backups. Media/scanner images contain native tools; build for the target server architecture. The scanner image currently uses its verified linux/amd64 variant, so an amd64 host avoids emulation.

## Build the release locally

Run from the orchestration workspace after the checks pass:

```sh
npm --prefix frontend run build
python3 backend/deploy/bundle.py --workspace . --output-dir /tmp/handoff-releases
```

The bundle contains built frontend files, backend source and locked dependencies, container definitions, and deployment tooling. It excludes Git internals, node_modules, local data, backups, and credentials. `manifest.json` records every input hash and the frontend source hashes. Its content hash determines the release image tag in `release.env`. Repeating packaging over unchanged inputs produces identical archive bytes. It does not prove that stale frontend output matches edited source, so build after the last frontend source change and before packaging.

Base images are pinned by digest. Node dependency versions are locked. APT package repositories remain external build inputs; the resulting container image digest, rather than an assumption about byte-identical Docker builds, is the deployment identity.

## Prepare a fresh target host

Transfer the archive and `.sha256` file using the operator's authenticated channel. Verify and extract into a new versioned directory under `/opt/handoff/releases`:

```sh
sha256sum -c handoff-RELEASE.tar.gz.sha256
mkdir /opt/handoff/releases/RELEASE
tar -xzf handoff-RELEASE.tar.gz -C /opt/handoff/releases/RELEASE
cd /opt/handoff/releases/RELEASE
sudo python3 backend/deploy/prepare-host.py /var/lib/handoff/data /etc/handoff/secrets
```

The preparation command creates private directories and a new random worker secret if one does not exist; it never prints or replaces an existing secret. Set `HANDOFF_DOCKER_GID` to the group ID it prints. The data and secret file are owned by UID 1000 so Docker Compose file-backed secrets remain readable by the nonroot runtime.

Copy `backend/deploy/release.env.example` to `/etc/handoff/release.env`, protect it with mode 600, and set the real HTTPS origin, paths, socket group, and release tag from the bundle's `release.env`. Keep `HANDOFF_RELEASE_STAGE=preview` and `TESTNET_PAYMENTS=0`. The worker secret lives in the separate secret file, not in this environment file.

Build sequentially on the target Docker host. Nothing below exposes a port or starts the app:

```sh
backend/deploy/build-release.sh /etc/handoff/release.env
python3 backend/deploy/render-coolify.py --env-file /etc/handoff/release.env --output /etc/handoff/coolify-compose.json
```

The image-only Compose output includes resolved configuration and must remain private. Add a Docker Compose service in the existing Coolify instance, use that JSON as its Compose definition, select the same Docker server on which the images were built, and assign the real HTTPS domain to the `gateway` service on port 8080. The JSON is valid YAML and removes build contexts so Coolify does not need access to nested source clones. It uses local release-tagged images with `pull_policy: never`. Have the operator review the concrete domain and service settings before deploying.

For CLI-managed validation on that host, the base Compose file is also runnable with `docker compose --env-file /etc/handoff/release.env -f backend/deploy/compose.yaml up -d`. Choose either Coolify management or direct Compose management for a given deployment; do not start duplicate stacks against the same data.

## Local container checks

The optional override publishes only the gateway to loopback and does not claim HTTPS/device acceptance:

```sh
docker compose --env-file /path/to/validation.env -f backend/deploy/compose.yaml -f backend/deploy/compose.local.yaml up -d
curl --fail http://127.0.0.1:8080/api/ready
```

Use a fresh validation data directory and worker secret. The configured origin remains an HTTPS value for production-mode checks, so mutation requests must carry that exact `Origin`; cookies marked Secure require actual HTTPS for browser/device acceptance. Stop the validation stack afterwards without deleting its volumes until any diagnostic data is reviewed.

`/api/ready` checks storage, scanner definitions, preview worker/image availability, and the reconciler. ClamAV's initial download can take several minutes. The gateway waits for API readiness at startup. Readiness reports dependency health; it does not gate every request. Scanner or preview-worker failure prevents new file processing. Previously verified, intact paid downloads remain available under their existing access and retention checks. Node's `/api/health` is the lightweight status route.

## Singleton, restart, and maintenance

The API entrypoint acquires `/data/.runtime.lock` using the kernel's exclusive nonblocking `flock`, then sets `HANDOFF_LOCK_MANAGED=1` and starts Node. A second API against the same data refuses to start. A process crash releases the kernel lock, allowing the next process to remove the stale advisory server marker safely. Do not remove `.runtime.lock`: its inode is the shared lock boundary.

The same entrypoint wraps offline `npm run ops -- ...` commands. Stop the API first and let maintenance acquire the same kernel lock; do not bypass the entrypoint or set managed-lock flags by hand. Keep the single API/reconciler replica. See `backend/deploy/ops/` for backup, restore, monitoring, and incident procedures supplied with the release.

Before public use, verify actual Nimiq Pay sign-in, desktop pairing, HTTPS routing, clean/scanner rejection paths, previews, access approvals, and recovery on the target host. Acceptance payments need configured real test-network RPCs, a confirmed six-decimal test token, funded test wallets, and verified finality/recovery evidence. Mainnet, production payment readiness, and a completed browser/device check are not claimed by this package.
