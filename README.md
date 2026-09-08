# Handoff

Show the work. Get paid. Release the originals.

Payment-gated freelancer delivery for Nimiq Pay. This repository uses independent surface branches and nested clones.

Run `./setup.sh` to clone frontend, backend, and docs. Read `docs/STATUS.md` for verified scope and release blockers. Backend owns `packages/contracts`; frontend consumes its versioned package archive.

Development: Node.js 24.15+. With Docker Desktop running, in backend run `npm ci && npm run services`, then `npm run demo` for the local-only sandbox or `npm start` for wallet mode. In frontend run `npm ci && npm run dev`. Open http://localhost:5173. The backend defaults to localhost:4003 and stores private data under backend/.data.

Read `docs/RUNBOOK.md` for the complete local and phone test journey. This is not a production-ready pilot: mainnet activation and real-device release checks remain blocked.
