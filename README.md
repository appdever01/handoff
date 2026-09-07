# Handoff

Show the work. Get paid. Release the originals.

Payment-gated freelancer delivery for Nimiq Pay. This repository uses independent surface branches and nested clones.

Run `./setup.sh` to clone frontend, backend, and docs. Read `docs/STATUS.md` for verified scope and release blockers. Backend owns `packages/contracts`; frontend consumes its versioned local package.

Development: Node.js 24.15+ (node:sqlite). In backend run `npm ci && npm run dev`. In frontend run `npm ci && npm run dev`. Open http://localhost:5173. The backend defaults to localhost:4003 and stores private data under backend/.data.

This is an initial development build, not a payment-ready pilot. No live payment can be submitted through it.
