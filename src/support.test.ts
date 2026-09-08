import { expect, test } from "vitest";
import { supportStatusLabels } from "./support-en";
import type { SupportTicket } from "@handoff/contracts";

test("operator-declined and refund-recorded requests retain their actual outcomes", () => {
  const statuses: SupportTicket["status"][] = [
    "open",
    "resolved",
    "refund-recorded",
    "declined",
  ];
  for (const status of statuses)
    expect(supportStatusLabels[status]).toBeTruthy();
  expect(supportStatusLabels.declined).toBe("Declined");
  expect(supportStatusLabels.declined).not.toBe(supportStatusLabels.resolved);
  expect(supportStatusLabels["refund-recorded"]).toBe(
    "Refund reference recorded",
  );
});
