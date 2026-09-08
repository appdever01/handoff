import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { encodeEventTopics, encodeAbiParameters, erc20Abi } from "viem";
import { polygonTestnet, nimiqTestnet, transferData } from "../src/chains.ts";
import type { PaymentIntent } from "../packages/contracts/index.ts";

async function mockRpc(
  handler: (method: string, params: unknown[]) => unknown,
) {
  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const { method, params } = JSON.parse(Buffer.concat(chunks).toString());
    res.setHeader("content-type", "application/json");
    try {
      res.end(
        JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          result: handler(method, params),
        }),
      );
    } catch {
      res.end(JSON.stringify({ jsonrpc: "2.0", id: 1, error: { code: -1 } }));
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
const payer = "0x1111111111111111111111111111111111111111";
const recipient = "0x2222222222222222222222222222222222222222";
const token = "0x3333333333333333333333333333333333333333";
const blockHash = "0x" + "aa".repeat(32);
const transaction = "0x" + "bb".repeat(32);
const intent: PaymentIntent = {
  id: "intent",
  handoff: "handoff",
  manifestHash: "manifest",
  currency: "USDT",
  payer,
  recipient,
  units: "1000000",
  network: "eip155:80002",
  token,
  reference: "7",
  startBlock: 10,
  createdAt: 100000,
  expiresAt: 200000,
};
test("Polygon adapter validates chain, nonce, canonical finalized block, calldata and successful transfer", async () => {
  let chain = "0x13882";
  let canonical = blockHash;
  let success = "0x1";
  let nonce = "0x7";
  let finalized = "0xc";
  let removed = false;
  let wrongInput = false;
  const rpc = await mockRpc((method, params) => {
    if (method === "eth_chainId") return chain;
    if (method === "eth_call") return "0x6";
    if (method === "eth_blockNumber") return "0xa";
    if (method === "eth_getTransactionCount") return "0x7";
    if (method === "eth_getBlockByNumber")
      return {
        number: params[0] === "finalized" ? finalized : "0xb",
        hash: canonical,
        timestamp: "0x96",
      };
    if (method === "eth_getLogs") {
      const filter = params[0] as { topics: string[] };
      assert.equal(
        filter.topics[0],
        encodeEventTopics({ abi: erc20Abi, eventName: "Transfer" })[0],
      );
      return [
        {
          address: token,
          transactionHash: transaction,
          blockHash,
          blockNumber: "0xb",
          removed,
          topics: encodeEventTopics({
            abi: erc20Abi,
            eventName: "Transfer",
            args: { from: payer, to: recipient },
          }),
          data: encodeAbiParameters([{ type: "uint256" }], [1000000n]),
        },
      ];
    }
    if (method === "eth_getTransactionByHash")
      return {
        from: payer,
        to: token,
        nonce,
        input: wrongInput ? "0x00" : transferData(intent),
        blockHash,
        value: "0x0",
      };
    if (method === "eth_getTransactionReceipt")
      return { status: success, blockHash };
    throw Error(method);
  });
  try {
    const adapter = polygonTestnet(rpc.url, token);
    assert.deepEqual(await adapter.prepare(payer), {
      startBlock: 10,
      reference: "7",
    });
    assert.equal((await adapter.find(intent)).length, 1);
    canonical = "0x00";
    assert.equal((await adapter.find(intent)).length, 0);
    canonical = blockHash;
    success = "0x0";
    assert.equal((await adapter.find(intent)).length, 0);
    success = "0x1";
    nonce = "0x8";
    assert.equal((await adapter.find(intent)).length, 0);
    nonce = "0x7";
    removed = true;
    assert.equal((await adapter.find(intent)).length, 0);
    removed = false;
    wrongInput = true;
    assert.equal((await adapter.find(intent)).length, 0);
    wrongInput = false;
    finalized = "0x9";
    assert.equal((await adapter.find(intent)).length, 0);
    chain = "0x89";
    await assert.rejects(adapter.prepare(payer), /Amoy/);
  } finally {
    await rpc.close();
  }
});
test("Nimiq adapter requires testnet consensus, macro finality, canonical inclusion and intent data", async () => {
  let consensus = true;
  let network = "TestAlbatross";
  let canonical = true;
  let macro = 32;
  const nim = {
    ...intent,
    currency: "NIM" as const,
    network: "nimiq:testalbatross",
    token: "native",
    reference: "intent-message",
  };
  const tx = {
    hash: "abcd",
    blockNumber: 12,
    timestamp: 150000,
    from: payer,
    to: recipient,
    value: 1000000,
    recipientData: Buffer.from(nim.reference).toString("hex"),
    executionResult: true,
  };
  const rpc = await mockRpc((method, params) => {
    if (method === "isConsensusEstablished") return { data: consensus };
    if (method === "getLatestBlock") return { data: { number: 35, network } };
    if (method === "getLastMacroBlock") return { data: macro };
    if (method === "getBlockByNumber")
      return {
        data:
          params[0] === macro
            ? { number: macro, hash: "macrohash", type: "macro" }
            : { hash: "microhash", transactions: canonical ? [tx] : [] },
      };
    if (method === "getTransactionsByAddress") return { data: [tx] };
    throw Error(method);
  });
  try {
    const adapter = nimiqTestnet(rpc.url);
    assert.equal((await adapter.find(nim)).length, 1);
    canonical = false;
    assert.equal((await adapter.find(nim)).length, 0);
    canonical = true;
    macro = 0;
    assert.equal((await adapter.find(nim)).length, 0);
    macro = 32;
    consensus = false;
    await assert.rejects(adapter.find(nim));
    consensus = true;
    network = "MainAlbatross";
    await assert.rejects(adapter.prepare(payer));
  } finally {
    await rpc.close();
  }
});
