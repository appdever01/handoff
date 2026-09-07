import { init } from "@nimiq/mini-app-sdk";
import type { Currency, Handoff, Session } from "@handoff/contracts";
import { en } from "./en";

export async function api<T>(path: string, options?: RequestInit): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`/api${path}`, {
      ...options,
      headers: {
        ...(options?.body instanceof FormData
          ? {}
          : { "Content-Type": "application/json" }),
        ...options?.headers,
      },
    });
  } catch {
    throw new Error(en.networkError);
  }
  const data = await response.json();
  if (!response.ok) throw new Error(data.error ?? en.networkError);
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
    await provider.listAccounts();
    const signed = await provider.sign(challenge.message);
    if (!("publicKey" in signed)) throw new Error(en.walletRejected);
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
  if (!accounts[0]) throw new Error(en.walletRejected);
  const message =
    "0x" +
    Array.from(new TextEncoder().encode(challenge.message), (byte) =>
      byte.toString(16).padStart(2, "0"),
    ).join("");
  const signature = await ethereum.request({
    method: "personal_sign",
    params: [message, accounts[0]],
  });
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
