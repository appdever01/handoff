import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type FormEvent,
} from "react";
import { init } from "@nimiq/mini-app-sdk";
import QRCode from "qrcode";
import type {
  FileRecord,
  Handoff,
  PaymentIntent,
  Receipt,
  Session,
  SupportTicket,
} from "@handoff/contracts";
import { api, ApiError, atomicAmount, nimiqPayUrl } from "./lib";
import { workflow as t } from "./workflow-en";
import { supportStatusLabels } from "./support-en";
const errorText = (error: unknown) =>
  error instanceof Error ? error.message : t.error;
type Pair = {
  id: string;
  phrase: string;
  role: string;
  origin: string;
  expires: number;
  url?: string;
};
type ReceiptState = {
  receipt: Receipt | null;
  intent: PaymentIntent | null;
  events: { file: string; at: number }[];
};

export function Pairing({
  id,
  user,
  connected,
}: {
  id?: string;
  user: Session | null;
  connected: (user: Session) => void;
}) {
  const [pair, setPair] = useState<Pair | null>(null);
  const [role, setRole] = useState("upload");
  const [phrase, setPhrase] = useState("");
  const [qr, setQr] = useState("");
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [devices, setDevices] = useState<
    { id: string; role: string; expires: number }[]
  >([]);
  async function refresh() {
    if (user && !user.scope)
      setDevices((await api<{ devices: typeof devices }>("/devices")).devices);
  }
  useEffect(() => {
    setDevices([]);
    void refresh().catch((e) => setError(errorText(e)));
    if (id && user)
      void api<{ pairing: Pair | null }>(`/pairings/${id}`)
        .then((r) => {
          setPair(r.pairing);
          if (!r.pairing) setMessage(t.expired);
        })
        .catch((e) => setError(errorText(e)));
  }, [id, user]);
  useEffect(() => {
    if (id || !pair) return;
    let stopped = false;
    let polling = false;
    const timer = window.setInterval(() => {
      if (Date.now() >= pair.expires) {
        setMessage(t.expired);
        window.clearInterval(timer);
        return;
      }
      if (polling) return;
      polling = true;
      void api<{ user: Session }>(`/pairings/${pair.id}/redeem`, {
        method: "POST",
      })
        .then((r) => {
          if (!stopped) {
            connected(r.user);
            setMessage(t.paired);
            setPair(null);
          }
        })
        .catch((e) => {
          if (!stopped && !(e instanceof ApiError && e.status === 409))
            setError(errorText(e));
        })
        .finally(() => {
          polling = false;
        });
    }, 3000);
    return () => {
      stopped = true;
      window.clearInterval(timer);
    };
  }, [pair, id]);
  async function start() {
    setBusy(true);
    setError("");
    try {
      const p = await api<Pair>("/pairings", {
        method: "POST",
        body: JSON.stringify({ role }),
      });
      setPair(p);
      setQr(
        await QRCode.toDataURL(nimiqPayUrl(p.url!), { width: 220, margin: 2 }),
      );
      setMessage(t.waiting);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }
  async function approve(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      await api(`/pairings/${id}/approve`, {
        method: "POST",
        body: JSON.stringify({ phrase: phrase.trim().toLowerCase() }),
      });
      setMessage(t.approved);
      setPair(null);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="panel workflow-panel">
      <h1>{t.pair}</h1>
      <p>{t.pairHelp}</p>
      {id ? (
        !user || user.scope ? (
          <div>
            <p>{t.signIn}</p>
            <a
              className="button secondary"
              href={nimiqPayUrl(window.location.href)}
            >
              {t.openInWallet}
            </a>
          </div>
        ) : (
          pair && (
            <form onSubmit={approve}>
              <p>
                {t.origin}: <strong>{pair.origin}</strong>
              </p>
              <p>
                {t.role}:{" "}
                <strong>
                  {pair.role === "upload" ? t.upload : t.download}
                </strong>
              </p>
              <label>
                {t.phrase}
                <input
                  value={phrase}
                  onChange={(e) => setPhrase(e.target.value)}
                  required
                  autoComplete="off"
                  placeholder={pair.phrase}
                />
              </label>
              <p>{pair.phrase}</p>
              <button className="button primary" disabled={busy}>
                {t.approve}
              </button>
            </form>
          )
        )
      ) : (
        <>
          <label>
            {t.role}
            <select value={role} onChange={(e) => setRole(e.target.value)}>
              <option value="upload">{t.upload}</option>
              <option value="download">{t.download}</option>
            </select>
          </label>
          <button
            className="button primary"
            disabled={busy}
            onClick={() => void start()}
          >
            {t.createPair}
          </button>
          {pair && (
            <div>
              <p>
                <strong>{pair.phrase}</strong>
              </p>
              {qr && <img src={qr} width="220" height="220" alt={t.pair} />}
              <p className="wallet-address">
                <a href={pair.url}>{pair.url}</a>
              </p>
            </div>
          )}
        </>
      )}
      {message && <p role="status">{message}</p>}
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {user && !user.scope && (
        <>
          <h2>{t.devices}</h2>
          {!devices.length && <p>{t.noDevices}</p>}
          {devices.map((d) => (
            <p key={d.id}>
              {d.role === "upload" ? t.upload : t.download} ·{" "}
              {new Date(d.expires).toLocaleString()}{" "}
              <button
                className="button secondary"
                onClick={() =>
                  void api(`/devices/${d.id}`, { method: "DELETE" })
                    .then(refresh)
                    .catch((e) => setError(errorText(e)))
                }
              >
                {t.revoke}
              </button>
            </p>
          ))}
        </>
      )}
    </section>
  );
}

export function DemoBar({ connected }: { connected: (user: Session) => void }) {
  const [enabled, setEnabled] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    void api<{ sandbox: boolean }>("/health")
      .then((r) => setEnabled(r.sandbox))
      .catch(() => {});
  }, []);
  async function login(role: string) {
    try {
      connected(
        (
          await api<{ user: Session }>("/demo/login", {
            method: "POST",
            body: JSON.stringify({ role }),
          })
        ).user,
      );
    } catch (e) {
      setError(errorText(e));
    }
  }
  return enabled ? (
    <aside className="notice demo-banner">
      <strong>{t.demo}</strong>
      <button
        className="button secondary"
        onClick={() => void login("creator")}
      >
        {t.demoCreator}
      </button>
      <button className="button secondary" onClick={() => void login("client")}>
        {t.demoClient}
      </button>
      {error && <p role="alert">{error}</p>}
    </aside>
  ) : null;
}

export async function walletPayment(
  intent: PaymentIntent,
  isCurrent = () => true,
) {
  const requireCurrent = () => {
    if (!isCurrent()) throw new Error(t.sessionChanged);
  };
  requireCurrent();
  if (
    !/^\d+$/.test(intent.units) ||
    BigInt(intent.units) <= 0n ||
    !Number.isFinite(intent.expiresAt) ||
    !intent.reference
  )
    throw new Error(t.invalidIntent);
  if (intent.expiresAt <= Date.now()) throw new Error(t.expiredIntent);
  if (intent.network === "local:simulation") {
    await api(`/demo/pay/${intent.id}`, { method: "POST" });
    return;
  }
  if (intent.currency === "NIM") {
    if (intent.network !== "nimiq:testalbatross") throw new Error(t.testOnly);
    if (BigInt(intent.units) > BigInt(Number.MAX_SAFE_INTEGER))
      throw new Error(t.invalidIntent);
    const provider = await init({ timeout: 5000 });
    const result = (await provider
      .request({
        method: "getLatestBlock",
        params: [false],
      })
      .catch(() => {
        throw new Error(t.networkCheckUnavailable);
      })) as { data?: { network?: string }; network?: string } | null;
    const network = result?.data?.network ?? result?.network;
    if (!network) throw new Error(t.networkCheckUnavailable);
    if (network !== "TestAlbatross") throw new Error(t.switchTestnet);
    requireCurrent();
    const accounts = await provider.listAccounts();
    if (
      !Array.isArray(accounts) ||
      !accounts.some(
        (address) =>
          address.replace(/\s/g, "").toUpperCase() ===
          intent.payer.replace(/\s/g, "").toUpperCase(),
      )
    )
      throw new Error(t.approvedWallet);
    requireCurrent();
    const sent = await provider.sendBasicTransactionWithData({
      recipient: intent.recipient,
      value: Number(intent.units),
      data: intent.reference,
    });
    if (typeof sent !== "string" || !sent) throw new Error(t.error);
    return;
  }
  if (intent.network !== "eip155:80002") throw new Error(t.testOnly);
  if (
    ![intent.payer, intent.recipient, intent.token].every((address) =>
      /^0x[0-9a-fA-F]{40}$/.test(address),
    ) ||
    !/^\d+$/.test(intent.reference) ||
    BigInt(intent.units) >= 2n ** 256n
  )
    throw new Error(t.invalidIntent);
  const provider = (
    window as unknown as {
      ethereum?: {
        request(input: {
          method: string;
          params?: unknown[];
        }): Promise<unknown>;
      };
    }
  ).ethereum;
  if (!provider) throw new Error(t.openWallet);
  await provider.request({
    method: "wallet_switchEthereumChain",
    params: [{ chainId: "0x13882" }],
  });
  if ((await provider.request({ method: "eth_chainId" })) !== "0x13882")
    throw new Error(t.testOnly);
  const accounts = (await provider.request({
    method: "eth_accounts",
  })) as string[];
  if (
    !Array.isArray(accounts) ||
    !accounts.some((a) => a.toLowerCase() === intent.payer.toLowerCase())
  )
    throw new Error(t.approvedWallet);
  const data =
    "0xa9059cbb" +
    intent.recipient.slice(2).toLowerCase().padStart(64, "0") +
    BigInt(intent.units).toString(16).padStart(64, "0");
  requireCurrent();
  const sent = await provider.request({
    method: "eth_sendTransaction",
    params: [
      {
        from: intent.payer,
        to: intent.token,
        value: "0x0",
        data,
        nonce: "0x" + BigInt(intent.reference).toString(16),
      },
    ],
  });
  if (typeof sent !== "string" || !sent) throw new Error(t.error);
}

export async function checkoutPayment(
  handoffId: string,
  isCurrent: () => boolean,
  onIntent: (intent: PaymentIntent) => void,
) {
  const result = await api<{ intent: PaymentIntent; receipt: Receipt | null }>(
    `/handoffs/${handoffId}/checkout`,
    { method: "POST" },
  );
  if (!isCurrent()) return null;
  if (!result.receipt) {
    onIntent(result.intent);
    await walletPayment(result.intent, isCurrent);
  }
  return isCurrent() ? result : null;
}

export function PaymentPanel({
  handoff,
  user,
  owner,
}: {
  handoff: Handoff;
  user: Session | null;
  owner: boolean;
}) {
  const [state, setState] = useState<ReceiptState>({
    receipt: null,
    intent: null,
    events: [],
  });
  const [authorized, setAuthorized] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [enabled, setEnabled] = useState(false);
  const [demo, setDemo] = useState(false);
  const current = useRef(0);
  const paymentSession = useRef(0);
  useLayoutEffect(() => {
    paymentSession.current += 1;
    setBusy(false);
    return () => {
      paymentSession.current += 1;
    };
  }, [user?.address, user?.currency, user?.scope, handoff.id]);
  async function refresh() {
    if (!user) return;
    const version = current.current;
    const result = await api<ReceiptState>(`/receipts/${handoff.id}`);
    if (current.current === version) {
      setState(result);
      setAuthorized(true);
      setError("");
    }
  }
  useEffect(() => {
    let active = true;
    setEnabled(false);
    void api<{ handoff: { checkoutEnabled: boolean } }>(`/public/${handoff.id}`)
      .then((r) => {
        if (active) setEnabled(r.handoff.checkoutEnabled);
      })
      .catch(() => {});
    void api<{ sandbox: boolean }>("/health")
      .then((r) => {
        if (active) setDemo(r.sandbox);
      })
      .catch((e) => {
        if (active) setError(errorText(e));
      });
    return () => {
      active = false;
    };
  }, [handoff.id, handoff.status]);
  useEffect(() => {
    current.current += 1;
    const version = current.current;
    setState({ receipt: null, intent: null, events: [] });
    setAuthorized(false);
    setError("");
    setMessage("");
    if (!user || handoff.status === "draft") return;
    let polling = false;
    const check = async () => {
      if (polling) return;
      polling = true;
      try {
        const result = await api<ReceiptState>(`/receipts/${handoff.id}`);
        if (version === current.current) {
          setState(result);
          setAuthorized(true);
          setError("");
        }
      } catch (e) {
        if (version === current.current) {
          if (e instanceof ApiError && (e.status === 404 || e.status === 403)) {
            setAuthorized(false);
            setState({ receipt: null, intent: null, events: [] });
          } else setError(errorText(e));
        }
      } finally {
        polling = false;
      }
    };
    void check();
    const timer = window.setInterval(() => void check(), 5000);
    return () => {
      current.current += 1;
      window.clearInterval(timer);
    };
  }, [user?.address, user?.currency, user?.scope, handoff.id, handoff.status]);
  async function pay() {
    const session = paymentSession.current;
    const isCurrent = () => paymentSession.current === session;
    setError("");
    setBusy(true);
    setMessage(t.approval);
    try {
      const result = await checkoutPayment(handoff.id, isCurrent, (intent) => {
        setState((s) => ({ ...s, intent }));
      });
      if (!result || !isCurrent()) return;
      if (!result.receipt) setMessage(t.sent);
      await refresh();
    } catch (e) {
      if (isCurrent()) {
        setError(errorText(e));
        setMessage("");
      }
    } finally {
      if (isCurrent()) setBusy(false);
    }
  }

  return (
    <section className="workflow-panel">
      <p>{t.fees}</p>
      {state.receipt ? (
        <ReceiptView
          receipt={state.receipt}
          files={owner ? [] : handoff.files}
        />
      ) : (
        <>
          <p className="notice">
            {enabled ? (demo ? t.demo : t.testOnly) : t.unavailable}
          </p>
          {!owner && user && enabled && authorized && !user.scope && (
            <>
              <button
                className="button primary full-width"
                disabled={busy || Date.parse(handoff.deadline) <= Date.now()}
                onClick={() => void pay()}
              >
                {state.intent ? t.retryWallet : demo ? t.simulate : t.pay}
              </button>
              {state.intent && <p>{t.retryHelp}</p>}
            </>
          )}
          {state.intent && <p role="status">{t.confirming}</p>}
          {!owner && !authorized && <p>{t.clientApproval}</p>}
          {!owner && user?.scope && <p>{t.walletOnly}</p>}
          {!owner && !user && (
            <a
              className="button secondary full-width"
              href={nimiqPayUrl(window.location.href)}
            >
              {t.openInWallet}
            </a>
          )}
        </>
      )}
      {user && authorized && (
        <button
          className="button secondary"
          disabled={busy}
          onClick={() => void refresh().catch((e) => setError(errorText(e)))}
        >
          {t.recover}
        </button>
      )}
      {message && !state.receipt && <p role="status">{message}</p>}
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {state.receipt && (
        <>
          <h3>{t.access}</h3>
          {state.events.length ? (
            state.events.map((e, i) => (
              <p key={`${e.at}-${i}`}>
                {handoff.files.find((f) => f.id === e.file)?.name} ·{" "}
                {new Date(e.at).toLocaleString()}
              </p>
            ))
          ) : (
            <p>{t.noAccess}</p>
          )}
        </>
      )}
      {user && authorized && (
        <Support key={`${handoff.id}-${user.address}`} id={handoff.id} />
      )}
    </section>
  );
}
export function ReceiptView({
  receipt,
  files,
}: {
  receipt: Receipt;
  files: FileRecord[];
}) {
  const [downloading, setDownloading] = useState<string | null>(null);
  const [error, setError] = useState("");
  const expired = receipt.expiresAt <= Date.now();
  async function download(file: FileRecord) {
    setDownloading(file.id);
    setError("");
    try {
      const response = await fetch(
        `/api/originals/${receipt.handoff}/${file.id}`,
      );
      if (!response.ok) {
        const result = await response.json().catch(() => null);
        throw new Error(result?.error ?? t.error);
      }
      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = file.name;
      document.body.append(link);
      link.click();
      link.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setDownloading(null);
    }
  }
  return (
    <div className="receipt">
      <h3>{t.paid}</h3>
      <p>
        <a href={`/h/${receipt.handoff}`}>{receipt.title}</a>
      </p>
      <p>
        {t.receiptAmount}:{" "}
        <strong>
          {atomicAmount(receipt.units, receipt.currency)} {receipt.currency}
        </strong>
      </p>
      <p className="wallet-address">
        {receipt.network} · {receipt.transaction}
      </p>
      <p className="wallet-address">
        {t.recipient}: {receipt.recipient}
      </p>
      <p>
        {t.paidAt}: {new Date(receipt.paidAt).toLocaleString()}
      </p>
      <p>
        {t.retention} {new Date(receipt.expiresAt).toLocaleString()}
      </p>
      {expired ? (
        <p>{t.expiredDownload}</p>
      ) : (
        files.map((f) => (
          <button
            className="button secondary full-width"
            key={f.id}
            disabled={downloading !== null}
            onClick={() => void download(f)}
          >
            {downloading === f.id
              ? t.downloading
              : `${t.downloadOriginal}: ${f.name}`}
          </button>
        ))
      )}
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
export function Purchases({ user }: { user: Session | null }) {
  const [items, setItems] = useState<
    { receipt: Receipt; files: FileRecord[] }[]
  >([]);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [revision, setRevision] = useState(0);
  const [search, setSearch] = useState("");
  useEffect(() => {
    setItems([]);
    setError("");
    setLoading(true);
    if (!user) {
      setLoading(false);
      return;
    }
    let active = true;
    void api<{ purchases: typeof items }>("/purchases")
      .then((r) => {
        if (active) setItems(r.purchases);
      })
      .catch((e) => {
        if (active) setError(errorText(e));
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [user?.address, user?.currency, revision]);
  const filtered = items.filter(({ receipt }) =>
    `${receipt.title} ${receipt.currency} ${receipt.transaction}`
      .toLowerCase()
      .includes(search.trim().toLowerCase()),
  );
  return (
    <section className="panel workflow-panel">
      <div className="section-heading">
        <h1>{t.purchases}</h1>
        {user && (
          <button
            className="button secondary"
            disabled={loading}
            onClick={() => setRevision((r) => r + 1)}
          >
            {t.refresh}
          </button>
        )}
      </div>
      {items.length > 0 && (
        <label>
          {t.purchaseSearch}
          <input
            type="search"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </label>
      )}
      {loading ? (
        <p role="status">{t.loading}</p>
      ) : !user ? (
        <p>{t.signInPurchases}</p>
      ) : filtered.length ? (
        filtered.map((item) => (
          <ReceiptView key={item.receipt.handoff} {...item} />
        ))
      ) : (
        !error && <p>{items.length ? t.noMatches : t.empty}</p>
      )}
      {error && <p role="alert">{error}</p>}
    </section>
  );
}
function Support({ id }: { id: string }) {
  const [message, setMessage] = useState("");
  const [kind, setKind] = useState("access");
  const [status, setStatus] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [tickets, setTickets] = useState<SupportTicket[]>([]);
  const [opened, setOpened] = useState(false);
  const kindLabel = { access: t.accessIssue, refund: t.refund, other: t.other };
  useEffect(() => {
    if (!opened) return;
    let active = true;
    void api<{ tickets: SupportTicket[] }>(`/support/${id}`)
      .then((r) => {
        if (active) setTickets(r.tickets);
      })
      .catch((e) => {
        if (active) setError(errorText(e));
      });
    return () => {
      active = false;
    };
  }, [id, opened]);
  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError("");
    setStatus("");
    try {
      const result = await api<{ ticket: SupportTicket }>(`/support/${id}`, {
        method: "POST",
        body: JSON.stringify({ kind, message: message.trim() }),
      });
      setTickets((items) => [result.ticket, ...items]);
      setStatus(t.saved);
      setMessage("");
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <details onToggle={(event) => setOpened(event.currentTarget.open)}>
      <summary>{t.support}</summary>
      <p>{t.supportNote}</p>
      <form onSubmit={submit}>
        <label>
          {t.kind}
          <select value={kind} onChange={(e) => setKind(e.target.value)}>
            <option value="access">{t.accessIssue}</option>
            <option value="refund">{t.refund}</option>
            <option value="other">{t.other}</option>
          </select>
        </label>
        <label>
          {t.message}
          <textarea
            required
            maxLength={2000}
            value={message}
            onChange={(e) => setMessage(e.target.value)}
          />
        </label>
        <button className="button secondary" disabled={busy || !message.trim()}>
          {t.sendRequest}
        </button>
        {status && <p role="status">{status}</p>}
        {error && (
          <p role="alert" className="error">
            {error}
          </p>
        )}
      </form>
      <h3>{t.requestHistory}</h3>
      {!tickets.length && <p>{t.noRequests}</p>}
      {tickets.map((ticket) => (
        <article key={ticket.id}>
          <strong>
            {kindLabel[ticket.kind]} · {supportStatusLabels[ticket.status]}
          </strong>
          <p>{ticket.message}</p>
          <p>{new Date(ticket.createdAt).toLocaleString()}</p>
          {ticket.refundTransaction && (
            <p className="wallet-address">
              {t.refundReference}: {ticket.refundTransaction}
            </p>
          )}
        </article>
      ))}
    </details>
  );
}

export function VideoPreview({ src, label }: { src: string; label: string }) {
  const [playing, setPlaying] = useState(false);
  const [error, setError] = useState(false);
  const canvas = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    if (playing) return;
    let active = true;
    const image = new Image();
    image.onload = () => {
      if (!active || !canvas.current) return;
      const target = canvas.current;
      target.width = image.naturalWidth;
      target.height = image.naturalHeight;
      target.getContext("2d")?.drawImage(image, 0, 0);
    };
    image.onerror = () => {
      if (active) setError(true);
    };
    image.src = src;
    return () => {
      active = false;
    };
  }, [src, playing]);
  return (
    <div className="video-preview">
      {playing ? (
        <img src={src} alt={label} />
      ) : (
        <canvas ref={canvas} role="img" aria-label={label} />
      )}
      {error && <p role="alert">{t.error}</p>}
      <button
        className="button secondary"
        onClick={() => setPlaying((value) => !value)}
      >
        {playing ? t.pausePreview : t.playPreview}
      </button>
    </div>
  );
}
