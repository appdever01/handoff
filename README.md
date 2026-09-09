![Handoff — Show the work. Get paid. Release the originals.](https://raw.githubusercontent.com/appdever01/handoff/frontend/public/og-image.jpg)

# Handoff

**Show the work. Get paid. Release the originals.**

Handoff helps freelancers share finished work with a client while keeping the original files private. Upload a delivery, approve its watermarked previews, set the agreed payment, and share one link. The client reviews the work; original downloads unlock only after the backend independently verifies a matching, finalized payment.

Built for **Nimiq Pay**, with NIM and Polygon USDT as the intended payment options. Payments are designed to go directly to the freelancer's verified wallet. Handoff controls file access and does not hold client funds.

[Open the preview](https://handoff-nimq.vercel.app)

> **Current stage: prelaunch preview.** Checkout is disabled on the hosted app, and mainnet payments are not enabled. A local sandbox supports the delivery-to-download journey with simulated payments. Real wallet and test-network payment acceptance, accessibility checks, and operational release gates remain outstanding.

## How it works

1. **Prepare the delivery.** Sign in, upload the originals, enter the price and terms, and review the watermarked previews.
2. **Approve and share.** Approve every preview, publish a fixed version of the delivery, and share its link through your existing client conversation.
3. **Confirm the client.** Bind the delivery to the intended client's wallet before checkout.
4. **Verify payment.** The backend checks payment details and chain finality independently. A wallet success message cannot unlock files.
5. **Release the originals.** The entitled client can download the exact published files and return through Purchases while download access remains valid.

The payment steps can be explored in the local sandbox. Genuine network payments still require the release checks described below.

## What is included

- **Private file delivery:** malware scanning, upload limits, file integrity checks, and immutable published deliveries.
- **Watermarked previews:** images, PDF contact sheets, and short animated MP4 previews. Editable PSD, Blender, and ZIP originals require a separate image or PDF preview.
- **Creator workspace:** drafts, client access requests, share links, delivery status, and wallet settings.
- **Client access:** purchases, receipts, authenticated downloads, and repeat downloads within the retention window.
- **Desktop pairing:** expiring QR/phrase approval and revocable sessions scoped to preparation or downloads.
- **Payment recovery:** persisted intents and background reconciliation that can resume after a page closes or the server restarts.
- **Support and operations:** private support requests, operator resolution records, readiness checks, and local backup/restore tools.

Previews can still be captured from a screen. The protection is keeping original file bytes private, not preventing screenshots. Handoff is not escrow and does not provide automatic refunds or dispute arbitration.

## Repository structure

This repository uses independent branches and nested clones rather than a shared package workspace. The `main` branch contains the README and Git ignore rules; each surface has its own Git history, dependencies, and validation.

| Surface                                                         | Branch     | Responsibility                                                               |
| --------------------------------------------------------------- | ---------- | ---------------------------------------------------------------------------- |
| [Frontend](https://github.com/appdever01/handoff/tree/frontend) | `frontend` | React 19, TypeScript, Vite, and the client interface                         |
| [Backend](https://github.com/appdever01/handoff/tree/backend)   | `backend`  | Fastify, SQLite, private files, scanning, previews, and payment verification |

After setup, the workspace looks like this:

```text
handoff/                 # Orchestration repository on main
├── README.md
├── frontend/            # Independent clone of frontend
└── backend/             # Independent clone of backend
    └── packages/contracts/
```

The backend owns `@handoff/contracts`. The frontend consumes a versioned archive from its `vendor/` directory, so it can install and build independently. Run Git and package commands inside the surface that owns the files; the root intentionally ignores the nested clones. Internal planning documents remain local and are not published on a documentation branch.

## Run locally

### Prerequisites

- Node.js **24.15 or newer**, with npm.
- Git and access to this repository.
- Docker with Compose, running before starting the scanner and preview services.

### 1. Clone the project

```sh
git clone https://github.com/appdever01/handoff.git
cd handoff
git clone --branch frontend --single-branch https://github.com/appdever01/handoff.git frontend
git clone --branch backend --single-branch https://github.com/appdever01/handoff.git backend
```

For an existing workspace, run only the clone commands for missing surfaces. Install dependencies inside each surface with `npm ci`; there is no root install step.

### 2. Start the backend sandbox

In one terminal, from the project root:

```sh
cd backend
npm ci
npm run services
docker compose logs -f scanner
```

Wait for `socket found, clamd started`, then press Ctrl-C to leave the log view and start the API:

```sh
npm run demo
```

This starts the API at `http://localhost:4003` with separate local sandbox storage. Scanning is mandatory even in demo mode; missing or stale scanner definitions block uploads.

### 3. Start the frontend

In a second terminal, from the project root:

```sh
cd frontend
npm ci
npm run dev
```

Open **http://localhost:5173** exactly. Vite proxies `/api` requests to the backend. The page should identify itself as **LOCAL SANDBOX**.

Use **Demo creator** to create a USDT delivery, upload files, approve the previews, and publish. Switch to **Demo client** to request access, return as the creator to approve it, then use **Simulate demo payment** as the client. Once reconciliation completes, inspect the receipt and download the originals. No wallet or real funds are needed for this simulation.

Keep sandbox mode on localhost and never expose it through a public tunnel. Its data lives in `backend/.sandbox-data`; ordinary wallet mode uses `backend/.data`.

To use wallet mode, stop the demo API and run `npm start` in `backend`. Checkout remains disabled by default. Phone pairing and test-network payments require separate configuration and acceptance checks.

Stop the frontend and API with Ctrl-C. Stop the scanner with `docker compose stop scanner` from `backend`.

## Validation

Run checks sequentially inside their owning surface. Test scripts cap concurrency at two workers.

```sh
cd backend
npm test
npm run typecheck
npm run test:services
cd ../frontend
npm test
npm run build
cd ../backend
npm run test:http
npm run test:runtime
```

The service and HTTP checks require Docker, a ready scanner, and the preview image built by `npm run services`. The HTTP check also requires the frontend build. These checks cover local services and simulated journeys; they do not establish real-device wallet or genuine payment acceptance.

## Deployment and release

The documented preview deployment uses **Vercel** for the frontend and **Railway** for the API and private ClamAV scanner. Frontend `/api` requests are forwarded to Railway; Cloudinary processes temporary preview inputs in this deployment. Local development uses isolated Docker preview jobs.

Originals and SQLite data need private persistent storage. Keep one API/reconciler process for this SQLite implementation. The API exposes `/api/health` for liveness and `/api/ready` for dependency readiness. Secrets belong in backend environment configuration, never in frontend code or Git.

Keep the hosted app in preview mode until genuine test payments, finality and interruption recovery, device access, accessibility, monitoring, and offsite restore checks pass. A successful build or healthy endpoint does not enable mainnet payments.

- [Railway deployment](https://github.com/appdever01/handoff/blob/backend/deploy/railway/README.md)
- [Alternative container deployment](https://github.com/appdever01/handoff/blob/backend/deploy/README.md)

## Assets and contributions

- [Brand assets](https://github.com/appdever01/handoff/tree/frontend/public): the README/social cover and favicon files. The same `og-image.jpg` is used for the README and website social preview.

Keep contributions within the owning surface, preserve the backend-owned contract boundary, and include validation appropriate to the change. Personal AI instructions and local setup helpers are excluded from version control.
