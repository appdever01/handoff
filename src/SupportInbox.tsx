import { useEffect, useState } from "react";
import type { Session, SupportTicket } from "@handoff/contracts";
import { api, formatDate } from "./lib";
import {
  supportText as t,
  supportStatusLabels as statusLabels,
} from "./support-en";

type Request = SupportTicket & { handoffId: string; title: string };
const kindLabels = { access: t.access, refund: t.refund, other: t.other };

export function SupportInbox({
  user,
  navigate,
}: {
  user: Session | null;
  navigate: (path: string) => void;
}) {
  const [items, setItems] = useState<Request[]>([]);
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState("all");
  const [refresh, setRefresh] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    setItems([]);
    setError("");
    if (!user) {
      setLoading(false);
      return;
    }
    const controller = new AbortController();
    setLoading(true);
    void api<{ tickets: Request[] }>("/support", { signal: controller.signal })
      .then(({ tickets }) => {
        if (!controller.signal.aborted) setItems(tickets);
      })
      .catch((failure) => {
        if (!controller.signal.aborted)
          setError(failure instanceof Error ? failure.message : t.error);
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [user?.address, user?.currency, user?.scope, refresh]);

  const query = search.trim().toLowerCase();
  const filtered = items.filter(
    (item) =>
      (status === "all" || item.status === status) &&
      `${item.title} ${item.message} ${item.id}`.toLowerCase().includes(query),
  );

  return (
    <section className="panel workflow-panel support-inbox">
      <h1>{t.title}</h1>
      <p>{t.description}</p>
      {!user ? (
        <p>{t.signIn}</p>
      ) : (
        <>
          <div className="support-controls">
            <label>
              {t.search}
              <input
                type="search"
                value={search}
                onChange={(event) => setSearch(event.target.value)}
              />
            </label>
            <label>
              {t.status}
              <select
                value={status}
                onChange={(event) => setStatus(event.target.value)}
              >
                <option value="all">{t.all}</option>
                {Object.entries(statusLabels).map(([value, label]) => (
                  <option key={value} value={value}>
                    {label}
                  </option>
                ))}
              </select>
            </label>
            <button
              type="button"
              className="button secondary"
              disabled={loading}
              onClick={() => setRefresh((value) => value + 1)}
            >
              {t.refresh}
            </button>
          </div>
          {loading ? (
            <p role="status">{t.loading}</p>
          ) : error ? (
            <p role="alert" className="error">
              {error}
            </p>
          ) : !items.length ? (
            <div className="empty-state small">
              <h2>{t.empty}</h2>
              <p>{t.emptyHelp}</p>
            </div>
          ) : !filtered.length ? (
            <p role="status">{t.noMatches}</p>
          ) : (
            <div className="support-list">
              {filtered.map((item) => (
                <article key={item.id} className="support-request">
                  <span
                    className={`status-pill ${item.status === "open" ? "awaiting-client" : item.status === "declined" ? "draft" : "paid"}`}
                  >
                    {statusLabels[item.status]}
                  </span>
                  <h2>{item.title}</h2>
                  <p>
                    {kindLabels[item.kind]} ·{" "}
                    {formatDate(new Date(item.createdAt).toISOString())}
                  </p>
                  <p className="support-message">{item.message}</p>
                  {item.refundTransaction && (
                    <div>
                      <p className="wallet-address">
                        {t.reference}: {item.refundTransaction}
                      </p>
                      <p>{t.refundNote}</p>
                    </div>
                  )}
                  <button
                    type="button"
                    className="button secondary"
                    onClick={() => navigate(`/h/${item.handoffId}`)}
                  >
                    {t.delivery}
                  </button>
                </article>
              ))}
            </div>
          )}
        </>
      )}
    </section>
  );
}
