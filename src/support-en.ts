import type { SupportTicket } from "@handoff/contracts";

export const supportText = {
  title: "Support requests",
  description: "View your saved help and refund requests.",
  signIn: "Connect your wallet to see your requests.",
  refresh: "Refresh requests",
  loading: "Loading requests…",
  search: "Search support requests",
  status: "Filter by status",
  all: "All requests",
  open: "Open",
  resolved: "Resolved",
  declined: "Declined",
  refundRecorded: "Refund reference added",
  access: "File access",
  refund: "Refund",
  other: "Other",
  empty: "No support requests yet.",
  emptyHelp: "Open a delivery to save a help or refund request.",
  noMatches: "No requests match your filters.",
  delivery: "Open delivery",
  reference: "Refund reference",
  refundNote:
    "A refund reference does not prove money was returned. Check it with the creator.",
  error: "Could not load your requests. Try again.",
} as const;

export const supportStatusLabels: Record<SupportTicket["status"], string> = {
  open: supportText.open,
  resolved: supportText.resolved,
  "refund-recorded": supportText.refundRecorded,
  declined: supportText.declined,
};
