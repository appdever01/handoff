import { afterEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { App, HandoffCard } from "./App";
import { samples } from "./samples";
import { en } from "./en";
import type { Handoff } from "@handoff/contracts";

const renderCard = (handoff: Handoff) =>
  renderToStaticMarkup(
    <HandoffCard
      handoff={handoff}
      open={() => {}}
      share={() => {}}
      remove={() => {}}
    />,
  );

afterEach(() => vi.unstubAllGlobals());

describe("real handoff workspace", () => {
  it("never presents example records as the disconnected user's workspace", () => {
    vi.stubGlobal("location", {
      pathname: "/",
      origin: "https://handoff.test",
    });
    const html = renderToStaticMarkup(<App />);
    expect(html).toContain(en.loadingWorkspace);
    for (const sample of samples) expect(html).not.toContain(sample.title);
    expect(html).toContain(en.navigation.requests);
    expect(html).toContain(en.navigation.support);
    expect(html).toContain(en.navigation.settings);
  });

  it("offers sharing for every published status and deletion only for drafts", () => {
    for (const status of [
      "awaiting-client",
      "ready",
      "payment-pending",
      "paid",
    ] as const) {
      const html = renderCard({ ...samples[0], status });
      expect(html).toContain(en.share);
      expect(html).not.toContain(en.deleteDraft);
    }
    const draft = renderCard({ ...samples[0], status: "draft" });
    expect(draft).toContain(en.deleteDraft);
    expect(draft).not.toContain(en.share);
  });

  it("retains the full six decimal USDT invoice amount", () => {
    expect(
      renderCard({ ...samples[0], currency: "USDT", amount: "1.123456" }),
    ).toContain("1.123456");
    expect(
      renderCard({ ...samples[0], currency: "NIM", amount: "0.00001" }),
    ).toContain("0.00001");
  });

  it("loads only existing clean previews and leaves quarantined files private", () => {
    const file = {
      ...samples[0].files[0],
      id: "original-id",
      scan: "clean" as const,
      previewSha256: "preview-hash",
      previewMime: "image/png",
    };
    const handoff = { ...samples[0], id: "real-id", files: [file] };
    expect(renderCard(handoff)).toContain("/api/previews/real-id/original-id");
    expect(
      renderCard({ ...handoff, files: [{ ...file, scan: "quarantined" }] }),
    ).not.toContain("<img");
    expect(
      renderCard({ ...handoff, files: [{ ...file, previewSha256: "" }] }),
    ).not.toContain("<img");
  });
});
