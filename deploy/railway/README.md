# Railway backend deployment

Use two Railway services in one environment: the API and a private ClamAV scanner. Both build from the existing `backend` branch with the source root left blank. Deploy the frontend from its `frontend` branch on Vercel first, then set the API's `APP_ORIGIN` to that frontend's exact HTTPS origin. The frontend must proxy `/api` requests to the Railway API so cookies remain attached to the frontend origin.

This package uses Node 24, the existing SQLite/original-file volume, and the Cloudinary preview adapter being wired in the backend. It does not use a Docker daemon, Docker socket, or the VPS-only preview worker. Keep `HANDOFF_RELEASE_STAGE=preview` and both payment flags disabled. Packaging alone does not establish live payment or device acceptance.

## Service settings

| Setting | API | Scanner |
| --- | --- | --- |
| Git source branch | `backend` | `backend` |
| Source root directory | Blank | Blank |
| `RAILWAY_DOCKERFILE_PATH` | `deploy/railway/Dockerfile` | `deploy/railway/Dockerfile.scanner` |
| Custom build command | Blank | Blank |
| Custom start command | Blank | Blank |
| Pre-deploy command | Blank | Blank |
| Persistent volume mount | `/data` | `/var/lib/clamav` |
| Replicas | Exactly 1 | 1 |
| API/daemon port | `PORT=4003` | TCP 3310 |
| Railway HTTP health path | `/api/ready` | Leave blank: clamd is TCP, not HTTP |
| Public networking | HTTPS API domain, target port 4003 | No public domain or TCP proxy |
| Initial resource budget | 1 CPU / 1 GiB RAM | 1 CPU / at least 2 GiB RAM |

Set the Dockerfile variable before deployment and confirm the build log uses the intended custom Dockerfile rather than Railpack. Railway documents `RAILWAY_DOCKERFILE_PATH` for custom file locations. [Dockerfile configuration](https://docs.railway.com/builds/dockerfiles).

Leave Custom Start Command blank. Railway replaces a Docker image's ENTRYPOINT when a custom command is set, which would bypass volume initialization, privilege dropping, and the process lock. If an explicit command is unavoidable, it must be `/usr/local/bin/handoff-railway-entrypoint node --import tsx src/server.ts`. [Start command behavior](https://docs.railway.com/deployments/start-command).

Use dashboard settings or Railway's current Infrastructure as Code workflow. Do not introduce `railway.toml` or `railway.json`: new services cannot opt into the deprecated Config as Code feature. [Current configuration guidance](https://docs.railway.com/config-as-code).

## Variables and secrets

`api.variables.example` and `scanner.variables.example` are templates for Railway's Variables raw editor, not shell scripts. Replace the frontend hostname and Cloudinary placeholders. Put the Cloudinary secret and API key only into the API service's private/sealed variables. The Dockerfile does not accept credentials as build arguments. `CLAMAV_HOST=${{scanner.RAILWAY_PRIVATE_DOMAIN}}` assumes the private service is named `scanner`; change the reference if the service has another name.

Use `PREVIEW_PROVIDER=cloudinary`, `CLOUDINARY_CLOUD_NAME`, `CLOUDINARY_API_KEY`, and `CLOUDINARY_API_SECRET`. Leave the VPS-only `PREVIEW_WORKER_URL`, `PREVIEW_WORKER_SECRET_FILE`, and `HANDOFF_MEDIA_IMAGE` unset. Do not manually set `HANDOFF_LOCK_MANAGED`: the entrypoint sets it only after acquiring the kernel lock.

Use Railway's injected `RAILWAY_VOLUME_MOUNT_PATH`; do not override it. `RAILWAY_RUN_UID=0` permits the short volume bootstrap. The entrypoint changes only `/data` itself to UID/GID 1000 and mode 0700, then drops to UID/GID 1000 with supplementary groups and capabilities removed before starting Node. Existing nested files are not recursively changed. A missing volume, wrong mount path, or symlinked lock refuses startup. Railway mounts volumes as root and only during runtime, so this cannot be moved into image build or pre-deploy commands. [Volume lifecycle and permissions](https://docs.railway.com/volumes).

The volume must have room for originals, previews, SQLite, and free-space headroom. The backend's current global upload quota is 5 GiB of original bytes; a volume of that size alone does not cover the other files. Keep storage alerts and verified backups enabled. A Railway volume backup is not a substitute for the application's coordinated snapshot and restore checks.

## Scanner and networking

The dedicated scanner image reuses the existing pinned ClamAV base and bounded scan configuration, adding both IPv4 and IPv6 listeners. Its upstream init process maintains fresh definitions and starts clamd as the `clamav` user. A persistent definitions volume avoids downloading the database on every deployment. Concurrent database reload is disabled to avoid holding two engines in memory under the 2 GiB budget; scans may briefly wait during a reload.

Deploy the scanner first. Its local diagnostic command is `clamdscan --config-file=/etc/clamav/clamd.conf --ping=1`. The image's Docker healthcheck is useful locally; Railway HTTP healthchecks cannot probe clamd's TCP protocol, so do not configure `/api/ready` or `/` on this service. The API's `/api/ready` probes the actual scanner and its definition freshness before the API becomes healthy.

`LISTEN_HOST=::` allows the Node API to listen on IPv6 as well as IPv4. The scanner configuration explicitly binds `0.0.0.0` and `::`; ClamAV supports repeated `TCPAddr` values. New Railway environments resolve private domains to both IP families, while older ones can be IPv6-only. Private services are reachable only inside their own project/environment. [Railway private networking](https://docs.railway.com/networking/private-networking/how-it-works), [ClamAV listener configuration](https://github.com/Cisco-Talos/clamav/blob/main/etc/clamd.conf.sample).

Combining ClamAV and the API in one container would reduce the number of service cards but would couple definition reloads, memory pressure, shutdown handling, and failures to wallet/file access. It would also place the scanner beside the API's original-file volume. The separate service is the recommended deployment boundary; no combined-process mode is provided.

## Health, restart, and deployment

Configure `/api/ready`, `PORT=4003`, and a 600-second startup health timeout on the API. Allow the scanner's first definition download to finish. Readiness checks storage, retained-file maintenance, payment reconciliation, scanner availability/freshness, and the configured preview provider. Railway checks health only while activating a deployment; configure ongoing monitoring separately. Volume-backed deployments can have brief downtime because Railway prevents concurrent mounts. [Railway healthchecks](https://docs.railway.com/deployments/healthchecks).

Keep deployment overlap at zero and allow 60 seconds for draining. Node is the final process, so it receives SIGTERM directly. The entrypoint holds `/data/.runtime.lock` with exclusive nonblocking `flock`; a second API fails with exit code 73. A crash releases the kernel lock. The backend then handles its stale advisory `.server-lock` while holding the kernel lock. Never delete `.runtime.lock` to force startup, run multiple API replicas, or run offline maintenance against a live API volume.

## Focused packaging checks

Shell syntax can be checked without Docker:

```sh
sh -n deploy/railway/entrypoint.sh
```

The following uses an already-built Node 24 image containing util-linux. It creates only temporary, uniquely named Docker volumes and containers, runs sequentially with CPU/memory limits, and cleans them up. It does not build images or touch Railway:

```sh
HANDOFF_RAILWAY_TEST_IMAGE=handoff-api:validation PYTHONDONTWRITEBYTECODE=1 python3 -m unittest discover -s deploy/railway -p test_entrypoint.py
```

The checks cover missing-volume refusal, private ownership and persistent bytes, removal of privileges, symlinked-lock refusal, singleton enforcement, and restart after SIGKILL. Run the actual Railway Dockerfile build separately once the backend's Cloudinary changes and required checks are ready. End-to-end Railway validation still needs the deployed scanner, real configured preview provider, persisted upload after restart, unpaid-original denial, and the frontend's same-origin API routing.

References checked 9 September 2026. No service, volume, domain, secret, or deployment is created by these files.
