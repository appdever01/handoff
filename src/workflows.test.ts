import { afterEach, expect, test, vi } from "vitest";
import type { PaymentIntent } from "@handoff/contracts";
import { checkoutPayment, walletPayment } from "./workflows";
const mocks = vi.hoisted(() => ({ init: vi.fn(), api: vi.fn() }));
vi.mock("@nimiq/mini-app-sdk", () => ({ init: mocks.init }));
vi.mock("./lib", () => ({ api: mocks.api }));
const intent: PaymentIntent = {
  id: "intent",
  handoff: "delivery",
  currency: "USDT",
  manifestHash: "hash",
  payer: "0x1111111111111111111111111111111111111111",
  recipient: "0x2222222222222222222222222222222222222222",
  units: "1000001",
  network: "eip155:80002",
  token: "0x3333333333333333333333333333333333333333",
  reference: "7",
  startBlock: 10,
  createdAt: 0,
  expiresAt: 9999999999999,
};
afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});
test("test USDT sends exact intent amount, recipient, token and reserved nonce", async () => {
  const request = vi.fn(
    async ({ method }: { method: string; params?: unknown[] }) =>
      method === "eth_chainId"
        ? "0x13882"
        : method === "eth_accounts"
          ? [intent.payer]
          : "hash",
  );
  vi.stubGlobal("window", { ethereum: { request } });
  await walletPayment(intent);
  const tx = request.mock.calls.find(
    ([input]) => input.method === "eth_sendTransaction",
  )?.[0] as unknown as {
    params: { to: string; nonce: string; data: string }[];
  };
  expect(tx.params[0].to).toBe(intent.token);
  expect(tx.params[0].nonce).toBe("0x7");
  expect(
    tx.params[0].data.endsWith(
      BigInt(intent.units).toString(16).padStart(64, "0"),
    ),
  ).toBe(true);
  expect(mocks.api).not.toHaveBeenCalled();
});
test("wrong chain and unsupported mainnet intents cannot send payment", async () => {
  const request = vi.fn(async ({ method }: { method: string }) =>
    method === "eth_chainId" ? "0x89" : [],
  );
  vi.stubGlobal("window", { ethereum: { request } });
  await expect(walletPayment(intent)).rejects.toThrow();
  expect(
    request.mock.calls.some(
      ([input]) => input.method === "eth_sendTransaction",
    ),
  ).toBe(false);
  await expect(
    walletPayment({ ...intent, network: "eip155:137" }),
  ).rejects.toThrow();
});
test("NIM requires a testnet node response before opening transaction approval", async () => {
  const send = vi.fn();
  mocks.init.mockResolvedValue({
    request: async () => ({ data: { network: "MainAlbatross" } }),
    sendBasicTransactionWithData: send,
  });
  await expect(
    walletPayment({
      ...intent,
      currency: "NIM",
      network: "nimiq:testalbatross",
    }),
  ).rejects.toThrow();
  expect(send).not.toHaveBeenCalled();
  mocks.init.mockResolvedValue({
    request: async () => ({ data: { network: "TestAlbatross" } }),
    listAccounts: async () => [intent.payer],
    sendBasicTransactionWithData: send.mockResolvedValue("hash"),
  });
  await walletPayment({
    ...intent,
    currency: "NIM",
    network: "nimiq:testalbatross",
  });
  expect(send).toHaveBeenCalledWith({
    recipient: intent.recipient,
    value: 1000001,
    data: "7",
  });
  expect(mocks.api).not.toHaveBeenCalled();
});

test("NIM refuses mainnet intents even when the wallet reports testnet", async () => {
  mocks.init.mockResolvedValue({
    request: async () => ({ data: { network: "TestAlbatross" } }),
    listAccounts: async () => [intent.payer],
    sendBasicTransactionWithData: vi.fn(),
  });
  await expect(
    walletPayment({ ...intent, currency: "NIM", network: "nimiq:albatross" }),
  ).rejects.toThrow();
  expect(mocks.init).not.toHaveBeenCalled();
});

test("unsafe, zero, malformed and expired atomic amounts never open the wallet", async () => {
  for (const units of ["9007199254740993", "0", "-1", "1.5"]) {
    await expect(
      walletPayment({
        ...intent,
        currency: "NIM",
        network: "nimiq:testalbatross",
        units,
      }),
    ).rejects.toThrow();
  }
  await expect(
    walletPayment({ ...intent, expiresAt: Date.now() - 1 }),
  ).rejects.toThrow();
  expect(mocks.init).not.toHaveBeenCalled();
});

test("USDT rejects malformed token, recipient and nonce before wallet approval", async () => {
  const request = vi.fn();
  vi.stubGlobal("window", { ethereum: { request } });
  for (const change of [
    { token: "0xBAD" },
    { recipient: "not-an-address" },
    { reference: "1.5" },
    { units: (2n ** 256n).toString() },
  ]) {
    await expect(walletPayment({ ...intent, ...change })).rejects.toThrow();
  }
  expect(request).not.toHaveBeenCalled();
});

test("wallet payment responses never grant entitlement and provider errors surface", async () => {
  mocks.init.mockResolvedValue({
    request: async () => ({ network: "TestAlbatross" }),
    listAccounts: async () => [intent.payer],
    sendBasicTransactionWithData: async () => ({
      error: { message: "declined" },
    }),
  });
  await expect(
    walletPayment({
      ...intent,
      currency: "NIM",
      network: "nimiq:testalbatross",
    }),
  ).rejects.toThrow();
  expect(mocks.api).not.toHaveBeenCalled();
});

test("a checkout response arriving after wallet switch or unmount never opens the wallet", async () => {
  for (const lifecycleChange of ["wallet changed", "component unmounted"]) {
    let active = true;
    let respond!: (result: { intent: PaymentIntent; receipt: null }) => void;
    mocks.api.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          respond = resolve;
        }),
    );
    const onIntent = vi.fn();
    const pending = checkoutPayment(intent.handoff, () => active, onIntent);
    active = false;
    respond({
      intent: { ...intent, currency: "NIM", network: "nimiq:testalbatross" },
      receipt: null,
    });
    await expect(pending, lifecycleChange).resolves.toBeNull();
    expect(onIntent).not.toHaveBeenCalled();
    expect(mocks.init).not.toHaveBeenCalled();
  }
});

test("wallet session change during account selection prevents NIM broadcast", async () => {
  let active = true;
  const send = vi.fn();
  mocks.init.mockResolvedValue({
    request: async () => ({ network: "TestAlbatross" }),
    listAccounts: async () => {
      active = false;
      return [intent.payer];
    },
    sendBasicTransactionWithData: send,
  });
  await expect(
    walletPayment(
      { ...intent, currency: "NIM", network: "nimiq:testalbatross" },
      () => active,
    ),
  ).rejects.toThrow("session changed");
  expect(send).not.toHaveBeenCalled();
});
