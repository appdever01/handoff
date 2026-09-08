import { afterEach, expect, test, vi } from "vitest";
import { api, ApiError, atomicAmount, connect, nimiqPayUrl } from "./lib";
const mocks = vi.hoisted(() => ({ init: vi.fn() }));
vi.mock("@nimiq/mini-app-sdk", () => ({ init: mocks.init }));
afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

test("API preserves status for session errors and safely handles proxy HTML", async () => {
  vi.stubGlobal(
    "fetch",
    vi
      .fn()
      .mockResolvedValue(
        new Response("<html>Unavailable</html>", { status: 503 }),
      ),
  );
  await expect(api("/health")).rejects.toMatchObject({
    name: "ApiError",
    status: 503,
  });
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ error: "Sign in again" }), {
        status: 401,
      }),
    ),
  );
  await expect(api("/session")).rejects.toEqual(
    new ApiError("Sign in again", 401),
  );
});

test("API accepts empty successful delete responses", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue(new Response(null, { status: 204 })),
  );
  await expect(
    api("/handoffs/draft", { method: "DELETE" }),
  ).resolves.toBeUndefined();
});

test("Nimiq account refusal cannot proceed to signing or authentication", async () => {
  const fetch = vi
    .fn()
    .mockResolvedValue(
      new Response(JSON.stringify({ id: "challenge", message: "sign-in" })),
    );
  const sign = vi.fn();
  vi.stubGlobal("fetch", fetch);
  mocks.init.mockResolvedValue({
    listAccounts: async () => ({ error: { message: "denied" } }),
    sign,
  });
  await expect(connect("NIM")).rejects.toThrow();
  expect(sign).not.toHaveBeenCalled();
  expect(fetch).toHaveBeenCalledTimes(1);
});

test("Nimiq login verifies only the wallet's signed server challenge", async () => {
  const user = { currency: "NIM", address: "NQ approved" };
  const fetch = vi
    .fn()
    .mockResolvedValueOnce(
      new Response(
        JSON.stringify({ id: "challenge", message: "server-issued-message" }),
      ),
    )
    .mockResolvedValueOnce(new Response(JSON.stringify({ user })));
  vi.stubGlobal("fetch", fetch);
  const sign = vi
    .fn()
    .mockResolvedValue({ publicKey: "public", signature: "signed" });
  mocks.init.mockResolvedValue({
    listAccounts: async () => [user.address],
    sign,
  });
  await expect(connect("NIM")).resolves.toEqual(user);
  expect(sign).toHaveBeenCalledWith("server-issued-message");
  expect(JSON.parse(fetch.mock.calls[1][1].body)).toEqual({
    currency: "NIM",
    challengeId: "challenge",
    publicKey: "public",
    signature: "signed",
  });
});

test("receipt formatting preserves every atomic unit and wallet link preserves delivery path", () => {
  expect(atomicAmount("1", "NIM")).toBe("0.00001");
  expect(atomicAmount("1000001", "USDT")).toBe("1.000001");
  expect(atomicAmount("999999999123456", "USDT")).toBe("999999999.123456");
  const url = "https://handoff.example/h/id?return=1&foo=2";
  expect(new URL(nimiqPayUrl(url)).searchParams.get("url")).toBe(url);
});

test("bodyless checkout and pairing requests do not claim an empty JSON payload", async () => {
  const fetch = vi
    .fn()
    .mockImplementation(async () => new Response(JSON.stringify({ ok: true })));
  vi.stubGlobal("fetch", fetch);
  await api("/handoffs/id/checkout", { method: "POST" });
  expect(fetch.mock.calls[0][1].headers.has("Content-Type")).toBe(false);
  await api("/auth/challenge", {
    method: "POST",
    body: JSON.stringify({ currency: "NIM" }),
  });
  expect(fetch.mock.calls[1][1].headers.get("Content-Type")).toBe(
    "application/json",
  );
  await api("/files", { method: "POST", body: new FormData() });
  expect(fetch.mock.calls[2][1].headers.has("Content-Type")).toBe(false);
});

test("EVM sign-in uses the selected account and hexadecimal server challenge", async () => {
  const address = "0x1111111111111111111111111111111111111111";
  const user = { currency: "USDT", address };
  const fetch = vi
    .fn()
    .mockResolvedValueOnce(
      new Response(JSON.stringify({ id: "challenge", message: "Sign in" })),
    )
    .mockResolvedValueOnce(new Response(JSON.stringify({ user })));
  const request = vi
    .fn()
    .mockImplementation(async ({ method }) =>
      method === "eth_requestAccounts" ? [address] : "0xsigned",
    );
  vi.stubGlobal("fetch", fetch);
  vi.stubGlobal("window", { ethereum: { request } });
  await expect(connect("USDT")).resolves.toEqual(user);
  expect(request).toHaveBeenLastCalledWith({
    method: "personal_sign",
    params: ["0x5369676e20696e", address],
  });
  expect(JSON.parse(fetch.mock.calls[1][1].body)).toEqual({
    currency: "USDT",
    challengeId: "challenge",
    signature: "0xsigned",
  });
});

test("cancelled EVM and Nimiq signatures never submit authentication proofs", async () => {
  const fetch = vi
    .fn()
    .mockImplementation(
      async () =>
        new Response(JSON.stringify({ id: "challenge", message: "Sign in" })),
    );
  vi.stubGlobal("fetch", fetch);
  const request = vi.fn().mockImplementation(async ({ method }) => {
    if (method === "eth_requestAccounts")
      return ["0x1111111111111111111111111111111111111111"];
    throw new Error("User declined");
  });
  vi.stubGlobal("window", { ethereum: { request } });
  await expect(connect("USDT")).rejects.toThrow("User declined");
  mocks.init.mockResolvedValue({
    listAccounts: async () => ["NQ approved"],
    sign: async () => ({ error: { message: "denied" } }),
  });
  await expect(connect("NIM")).rejects.toThrow();
  expect(fetch.mock.calls.map(([url]) => url)).toEqual([
    "/api/auth/challenge",
    "/api/auth/challenge",
  ]);
});
