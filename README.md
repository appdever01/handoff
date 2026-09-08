# Handoff frontend

React/TypeScript interface for preparing and reviewing freelancer deliveries. The signed-out workspace contains clearly labelled example projects. Connecting a wallet replaces them with that wallet's handoffs. No sample project accepts payment or serves an original file.

## Run

Use Node.js 24.15 or newer. Run `npm ci` and `npm run dev`, then open `http://localhost:5173`. Start the sibling backend separately on port 4003. The frontend proxies `/api` to it; it has no secrets or API credentials. NIM connection requires the Nimiq Pay injected provider; Polygon sign-in uses an EIP-1193 provider. Actual wallet flows remain a device-test gate.

## Build and checks

`npm test` runs focused tests with two Vitest workers. `npm run build` runs the TypeScript check then emits the static site under `dist`. `npm run typecheck` checks types only. Fonts are bundled locally. Responsive rules and reduced-motion support are included; visual/browser accessibility verification is still pending.

The frontend can install and build independently from its branch: the versioned contract archive lives in `vendor/` and is produced from the backend-owned package. Do not edit another schema copy here.

For hosting, use SPA fallback for `/h/*`, `/draft/*`, `/example/*`, `/purchases` and `/how-it-works`, and proxy `/api/*` to the backend on the same origin. This is not deployment approval. Read `../docs/STATUS.md` for blockers.

The current continuation adds pairing QR/phrase approval and revocation, a clearly labelled local demo identity switcher, test-only wallet checkout, payment recovery, receipts, purchases, downloads and support requests. Supplied previews for editable source files are available in creator tools. See `../docs/RUNBOOK.md` for the complete demo and phone journey. The `/pair` and `/pair/*` routes also require SPA fallback. Browser/device accessibility checks remain unverified.
