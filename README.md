# Handoff backend

Development-only API for wallet sign-in, image upload, private previews, immutable publishing and client wallet approval. Checkout is disabled and originals cannot be downloaded. Production startup intentionally refuses to run until release gates are completed.

## Run

Use Node.js 24.15 or newer. Run `npm ci`, then `npm run dev`. The API listens on `127.0.0.1:4003`. Open the frontend at exactly `http://localhost:5173`; its development proxy handles `/api`.

Optional environment variables: `PORT` (4003), `APP_ORIGIN` (`http://localhost:5173`), `DATA_DIR` (`.data`). Data directory contains SQLite, private originals and generated previews. Never expose it through a static file server. No wallet secret or provider API key is required for this slice.

The local `clamscan` command and updated virus definitions are required for publishing. Missing or failed scanning quarantines the file. Install and configure ClamAV for your operating system, update definitions, then use **Retry malware scan** on the selected draft file. There is no scanner bypass environment flag. Test-only dependency injection is confined to imported app construction; the runtime entry point always uses ClamAV.

## Checks

`npm test` runs API and cryptographic tests with at most two test workers. `npm run typecheck` checks all source, contracts and tests. No browser test or real wallet payment is included. Native Sharp processing is capped at two threads, and upload/scan concurrency at two requests.

## API boundary

`packages/contracts` owns the shared types and draft validation. Frontend consumes a versioned tarball. To update it, bump the version, run `npm pack` from that package with a destination in the frontend's `vendor` directory, then update the frontend package dependency and lockfile.

Read `../docs/ARCHITECTURE.md`, `../docs/DELIVERY-PLAN.md` and `../docs/STATUS.md` before production work. SQLite/local disk are development adapters, not an approved production design.
