import type { Handoff } from "@handoff/contracts";

export const samples: Handoff[] = [
  {
    id: "olive",
    title: "Olive Studio — Brand identity",
    clientLabel: "Olive Studio",
    description:
      "A fresh identity for a slower, more intentional kind of studio. Your final logo, color palette, and brand applications, ready for the world.",
    amount: "250",
    currency: "USDT",
    status: "awaiting-client",
    createdAt: "2026-09-07T10:00:00Z",
    files: ["Brand presentation.jpg", "Primary logo.png", "Color palette.png"],
  },
  {
    id: "form",
    title: "Form & Field — Campaign",
    clientLabel: "Form & Field",
    description:
      "Campaign artwork exploring the space between simple forms and bold ideas.",
    amount: "180",
    currency: "USDT",
    status: "ready",
    createdAt: "2026-09-06T10:00:00Z",
    files: ["Campaign poster.jpg", "Social artwork.png"],
  },
  {
    id: "kin",
    title: "Kinfolk — Packaging concept",
    clientLabel: "Kinfolk Coffee",
    description:
      "A warm, welcoming packaging direction for a very good cup of coffee.",
    amount: "50000",
    currency: "NIM",
    status: "draft",
    createdAt: "2026-09-05T10:00:00Z",
    files: ["Packaging concept.jpg"],
  },
].map((h) => ({
  ...h,
  currency: h.currency as Handoff["currency"],
  status: h.status as Handoff["status"],
  creator: "Example creator",
  clientWallet: null,
  terms:
    "Example terms: final artwork for the agreed brand use. Contact the creator for additional licenses or revisions.",
  deadline: "2026-09-25T23:59:00Z",
  publishedAt: null,
  manifestHash: null,
  files: h.files.map((name, i) => ({
    id: String(i),
    name,
    bytes: (i + 1) * 1400000,
    mime: "image/jpeg",
    sha256: "",
    previewSha256: "",
    scan: "clean" as const,
    approved: true,
  })),
}));
