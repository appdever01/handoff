# Handoff backend

Fastify/SQLite API for verified wallet sign-in, private delivery preparation, scoped desktop pairing, immutable test payment intents, independent reconciliation, receipts and authenticated downloads. Production/mainnet remains gated.

Use Node.js 24.15+ and Docker Desktop. Run `npm ci`, `npm run services`, then `npm run demo` for the loopback-only sandbox or `npm start` for wallet mode. Open the frontend at exactly `http://localhost:5173`. The API listens on port 4003. No scanner bypass exists; missing or stale scanning blocks publication.

`npm test` uses at most two workers. `npm run typecheck`, `npm run test:services`, and `npm run test:http` cover code, real local services and the built frontend/API respectively. The HTTP smoke requires the sibling frontend build. `npm run ops -- backup|restore|support|resolve-support ...` provides offline maintenance.

Backend owns `packages/contracts` version 0.2.0; frontend consumes its versioned archive. See [RUNBOOK](../docs/RUNBOOK.md) for exact setup, phone testing, backup/restore and support instructions, and [STATUS](../docs/STATUS.md) for unresolved P0 gates.
