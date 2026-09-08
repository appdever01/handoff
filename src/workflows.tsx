import { useEffect, useRef, useState, type FormEvent } from "react";
import { init } from "@nimiq/mini-app-sdk";
import QRCode from "qrcode";
import type {
  FileRecord,
  Handoff,
  PaymentIntent,
  Receipt,
  Session,
} from "@handoff/contracts";
import { api } from "./lib";
import { workflow as t } from "./workflow-en";
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
    if (user)
      setDevices((await api<{ devices: typeof devices }>("/devices")).devices);
  }
  useEffect(() => {
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
    const timer = window.setInterval(() => {
      if (Date.now() >= pair.expires) {
        setMessage(t.expired);
        window.clearInterval(timer);
        return;
      }
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
        .catch(() => {});
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
      setQr(await QRCode.toDataURL(p.url!, { width: 220, margin: 2 }));
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
        body: JSON.stringify({ phrase }),
      });
      setMessage(t.paired);
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
        !user ? (
          <p>{t.signIn}</p>
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
      {user && (
        <>
          <h2>{t.devices}</h2>
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

export async function walletPayment(intent: PaymentIntent) {
  if (intent.network === "local:simulation") {
    await api(`/demo/pay/${intent.id}`, { method: "POST" });
    return;
  }
  if (intent.currency === "NIM") {
    const provider = await init({ timeout: 5000 });
    const result = (await provider.request({
      method: "getLatestBlock",
      params: [false],
    })) as { data?: { network?: string }; network?: string };
    if ((result.data?.network ?? result.network) !== "TestAlbatross")
      throw new Error(t.switchTestnet);
    const accounts = await provider.listAccounts();
    if (!Array.isArray(accounts) || !accounts.includes(intent.payer))
      throw new Error(t.approvedWallet);
    const sent = await provider.sendBasicTransactionWithData({
      recipient: intent.recipient,
      value: Number(intent.units),
      data: intent.reference,
    });
    if (typeof sent !== "string") throw new Error(t.error);
    return;
  }
  if (intent.network !== "eip155:80002") throw new Error(t.testOnly);
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
  if (!accounts.some((a) => a.toLowerCase() === intent.payer.toLowerCase()))
    throw new Error(t.approvedWallet);
  const data =
    "0xa9059cbb" +
    intent.recipient.slice(2).toLowerCase().padStart(64, "0") +
    BigInt(intent.units).toString(16).padStart(64, "0");
  await provider.request({
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
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [enabled, setEnabled] = useState(false);
  const [demo, setDemo] = useState(false);
  async function refresh() {
    if (user) setState(await api<ReceiptState>(`/receipts/${handoff.id}`));
  }
  useEffect(() => {
    void api<{ checkoutEnabled: boolean; sandbox: boolean }>("/health")
      .then((r) => {
        setEnabled(r.checkoutEnabled);
        setDemo(r.sandbox);
      })
      .catch((e) => setError(errorText(e)));
  }, []);
  useEffect(() => {
    if (!user) return;
    let active = true;
    const check = () => {
      void api<ReceiptState>(`/receipts/${handoff.id}`)
        .then((r) => {
          if (active) setState(r);
        })
        .catch(() => {});
    };
    check();
    const timer = window.setInterval(check, 5000);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, [user, handoff.id]);
  async function pay() {
    setError("");
    setBusy(true);
    setMessage(t.approval);
    try {
      const result = await api<{
        intent: PaymentIntent;
        receipt: Receipt | null;
      }>(`/handoffs/${handoff.id}/checkout`, { method: "POST" });
      if (result.receipt) {
        await refresh();
        return;
      }
      setState((s) => ({ ...s, intent: result.intent }));
      await walletPayment(result.intent);
      setMessage(t.sent);
      await refresh();
    } catch (e) {
      setError(errorText(e));
      setMessage(t.confirming);
    } finally {
      setBusy(false);
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
          <p className="notice">{enabled ? t.testOnly : t.unavailable}</p>
          {!owner && user && enabled && (
            <button
              className="button primary full-width"
              disabled={busy || Date.parse(handoff.deadline) <= Date.now()}
              onClick={() => void pay()}
            >
              {demo ? t.simulate : t.pay}
            </button>
          )}
          {state.intent && <p role="status">{t.confirming}</p>}
          <p>{t.clientApproval}</p>
        </>
      )}
      {user && (
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
      {user && <Support id={handoff.id} />}
    </section>
  );
}
function ReceiptView({
  receipt,
  files,
}: {
  receipt: Receipt;
  files: FileRecord[];
}) {
  const expired = receipt.expiresAt <= Date.now();
  return (
    <div className="receipt">
      <h3>{t.paid}</h3>
      <p>{receipt.title}</p>
      <p className="wallet-address">
        {receipt.network} · {receipt.transaction}
      </p>
      <p>
        {t.retention} {new Date(receipt.expiresAt).toLocaleString()}
      </p>
      {expired ? (
        <p>{t.expiredDownload}</p>
      ) : (
        files.map((f) => (
          <a
            className="button secondary full-width"
            key={f.id}
            href={`/api/originals/${receipt.handoff}/${f.id}`}
            download
          >
            {t.downloadOriginal}: {f.name}
          </a>
        ))
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
  useEffect(() => {
    setLoading(true);
    if (!user) {
      setItems([]);
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
  }, [user]);
  return (
    <section className="panel workflow-panel">
      <h1>{t.purchases}</h1>
      {loading ? (
        <p role="status">{t.loading}</p>
      ) : items.length ? (
        items.map((item) => (
          <ReceiptView key={item.receipt.handoff} {...item} />
        ))
      ) : (
        <p>{t.empty}</p>
      )}
      {error && <p role="alert">{error}</p>}
    </section>
  );
}
function Support({ id }: { id: string }) {
  const [message, setMessage] = useState("");
  const [kind, setKind] = useState("access");
  const [status, setStatus] = useState("");
  const [busy, setBusy] = useState(false);
  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      await api(`/support/${id}`, {
        method: "POST",
        body: JSON.stringify({ kind, message }),
      });
      setStatus(t.saved);
      setMessage("");
    } catch (e) {
      setStatus(errorText(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <details>
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
        <button className="button secondary" disabled={busy}>
          {t.sendRequest}
        </button>
        <p role="status">{status}</p>
      </form>
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
