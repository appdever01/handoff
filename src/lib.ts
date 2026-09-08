import { init } from "@nimiq/mini-app-sdk";
import type { Currency, Handoff, Session } from "@handoff/contracts";
import { en } from "./en";

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export function nimiqPayUrl(url: string) {
  return `nimiqpay://miniapp?url=${encodeURIComponent(url)}`;
}

export function atomicAmount(units: string, currency: Currency) {
  const decimals = currency === "NIM" ? 5 : 6;
  const padded = units.padStart(decimals + 1, "0");
  const whole = padded.slice(0, -decimals);
  const fraction = padded.slice(-decimals).replace(/0+$/, "");
  return fraction ? `${whole}.${fraction}` : whole;
}

export async function api<T>(path: string, options?: RequestInit): Promise<T> {
  const headers = new Headers(options?.headers);
  if (
    options?.body != null &&
    !(options.body instanceof FormData) &&
    !headers.has("Content-Type")
  ) {
    headers.set("Content-Type", "application/json");
  }
  let response: Response;
  try {
    response = await fetch(`/api${path}`, {
      ...options,
      headers,
    });
  } catch {
    throw new Error(en.networkError);
  }
  const data = await response.json().catch(() => null);
  if (!response.ok) {
    throw new ApiError(
      typeof data?.error === "string" ? data.error : en.networkError,
      response.status,
    );
  }
  if (response.status === 204) return undefined as T;
  if (data === null) throw new ApiError(en.networkError, response.status);
  return data;
}
export async function connect(currency: Currency): Promise<Session> {
  const challenge = await api<{ id: string; message: string }>(
    "/auth/challenge",
    { method: "POST", body: JSON.stringify({ currency }) },
  );
  if (currency === "NIM") {
    const provider = await init({ timeout: 3000 }).catch(() => {
      throw new Error(en.walletMissing);
    });
    const accounts = await provider.listAccounts();
    if (!Array.isArray(accounts) || !accounts.length)
      throw new Error(en.walletRejected);
    const signed = await provider.sign(challenge.message);
    if (
      !signed ||
      !("publicKey" in signed) ||
      !signed.publicKey ||
      !signed.signature
    )
      throw new Error(en.walletRejected);
    return (
      await api<{ user: Session }>("/auth/verify", {
        method: "POST",
        body: JSON.stringify({
          currency,
          challengeId: challenge.id,
          publicKey: signed.publicKey,
          signature: signed.signature,
        }),
      })
    ).user;
  }
  const ethereum = (
    window as unknown as {
      ethereum?: {
        request(input: {
          method: string;
          params?: unknown[];
        }): Promise<unknown>;
      };
    }
  ).ethereum;
  if (!ethereum) throw new Error(en.walletMissing);
  const accounts = (await ethereum.request({
    method: "eth_requestAccounts",
  })) as string[];
  if (!Array.isArray(accounts) || !accounts[0])
    throw new Error(en.walletRejected);
  const message =
    "0x" +
    Array.from(new TextEncoder().encode(challenge.message), (byte) =>
      byte.toString(16).padStart(2, "0"),
    ).join("");
  const signature = await ethereum.request({
    method: "personal_sign",
    params: [message, accounts[0]],
  });
  if (typeof signature !== "string" || !signature)
    throw new Error(en.walletRejected);
  return (
    await api<{ user: Session }>("/auth/verify", {
      method: "POST",
      body: JSON.stringify({ currency, challengeId: challenge.id, signature }),
    })
  ).user;
}
export function filterHandoffs(
  handoffs: Handoff[],
  filter: string,
  search: string,
  sort: string,
) {
  return handoffs
    .filter(
      (h) =>
        (filter === "all" || h.status === filter) &&
        `${h.title} ${h.clientLabel}`
          .toLowerCase()
          .includes(search.trim().toLowerCase()),
    )
    .sort(
      (a, b) =>
        (Date.parse(b.createdAt) - Date.parse(a.createdAt)) *
        (sort === "oldest" ? -1 : 1),
    );
}
export const shortAddress = (address: string) =>
  `${address.slice(0, 8)}…${address.slice(-5)}`;
export const formatBytes = (bytes: number) =>
  new Intl.NumberFormat("en", { maximumFractionDigits: 1 }).format(
    bytes / 1024 / 1024,
  ) + " MB";
export const formatDate = (date: string) =>
  new Intl.DateTimeFormat("en", {
    day: "numeric",
    month: "short",
    year: "numeric",
  }).format(new Date(date));
