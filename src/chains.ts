import { randomUUID } from "node:crypto";
import { encodeFunctionData, erc20Abi, getAddress, decodeEventLog } from "viem";
import { z } from "zod";
import type { PaymentAdapter, ChainEvidence } from "./payments.ts";
import type { PaymentIntent } from "../packages/contracts/index.ts";

const hex = z.string().regex(/^0x[0-9a-fA-F]+$/);
const block = z.object({ number: hex, hash: hex, timestamp: hex });
export function rpc(url: string) {
  const parsed = new URL(url);
  if (!["http:", "https:"].includes(parsed.protocol))
    throw new Error("Invalid RPC endpoint");
  return async (method: string, params: unknown[] = []): Promise<unknown> => {
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) throw new Error("RPC unavailable");
    const body = (await response.json()) as {
      result?: unknown;
      error?: unknown;
    };
    if (body.error || body.result === undefined)
      throw new Error(`RPC ${method} failed`);
    return body.result;
  };
}
export const transferData = (intent: PaymentIntent) =>
  encodeFunctionData({
    abi: erc20Abi,
    functionName: "transfer",
    args: [intent.recipient as `0x${string}`, BigInt(intent.units)],
  });
export function polygonTestnet(
  url: string,
  tokenAddress: string,
): PaymentAdapter {
  const call = rpc(url);
  const token = getAddress(tokenAddress);
  const network = "eip155:80002";
  const check = async () => {
    if (BigInt(hex.parse(await call("eth_chainId"))) !== 80002n)
      throw new Error("Only Polygon Amoy is allowed");
    if (
      BigInt(
        hex.parse(
          await call("eth_call", [{ to: token, data: "0x313ce567" }, "latest"]),
        ),
      ) !== 6n
    )
      throw new Error("Test token must use six decimals");
  };
  return {
    network,
    token,
    async prepare(payer) {
      await check();
      return {
        startBlock: Number(BigInt(hex.parse(await call("eth_blockNumber")))),
        reference: BigInt(
          hex.parse(await call("eth_getTransactionCount", [payer, "pending"])),
        ).toString(),
      };
    },
    async find(intent) {
      await check();
      const finalized = block.parse(
        await call("eth_getBlockByNumber", ["finalized", false]),
      );
      const last = Number(BigInt(finalized.number));
      const found: ChainEvidence[] = [];
      const topic = (address: string) =>
        "0x" + address.slice(2).toLowerCase().padStart(64, "0");
      for (let start = intent.startBlock; start <= last; start += 2000) {
        const logs = z
          .array(
            z.object({
              address: hex,
              transactionHash: hex,
              blockHash: hex,
              blockNumber: hex,
              data: hex,
              topics: z.array(hex),
              removed: z.boolean(),
            }),
          )
          .parse(
            await call("eth_getLogs", [
              {
                address: token,
                fromBlock: `0x${start.toString(16)}`,
                toBlock: `0x${Math.min(last, start + 1999).toString(16)}`,
                topics: [
                  "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef",
                  topic(intent.payer),
                  topic(intent.recipient),
                ],
              },
            ]),
          );
        for (const log of logs) {
          if (log.removed || getAddress(log.address) !== token) continue;
          const tx = z
            .object({
              from: hex,
              to: hex,
              nonce: hex,
              input: hex,
              blockHash: hex,
              value: hex,
            })
            .parse(
              await call("eth_getTransactionByHash", [log.transactionHash]),
            );
          if (
            getAddress(tx.from) !== intent.payer ||
            getAddress(tx.to) !== token ||
            BigInt(tx.nonce).toString() !== intent.reference ||
            tx.input.toLowerCase() !== transferData(intent).toLowerCase() ||
            BigInt(tx.value) !== 0n
          )
            continue;
          const receipt = z
            .object({ status: hex, blockHash: hex })
            .parse(
              await call("eth_getTransactionReceipt", [log.transactionHash]),
            );
          const canonical = block.parse(
            await call("eth_getBlockByNumber", [log.blockNumber, false]),
          );
          if (
            receipt.status !== "0x1" ||
            receipt.blockHash !== canonical.hash ||
            tx.blockHash !== canonical.hash ||
            log.blockHash !== canonical.hash
          )
            continue;
          const event = decodeEventLog({
            abi: erc20Abi,
            data: log.data as `0x${string}`,
            topics: log.topics as [`0x${string}`, ...`0x${string}`[]],
            eventName: "Transfer",
          });
          found.push({
            transaction: log.transactionHash.toLowerCase(),
            blockHash: canonical.hash,
            block: Number(BigInt(canonical.number)),
            timestamp: Number(BigInt(canonical.timestamp)) * 1000,
            payer: getAddress(event.args.from),
            recipient: getAddress(event.args.to),
            units: event.args.value.toString(),
            network,
            token,
            reference: BigInt(tx.nonce).toString(),
            finalized: Number(BigInt(canonical.number)) <= last,
            success: true,
          });
        }
      }
      return found;
    },
  };
}
export function nimiqTestnet(url: string): PaymentAdapter {
  const raw = rpc(url);
  const call = async (method: string, params: unknown[] = []) =>
    z.object({ data: z.unknown() }).parse(await raw(method, params)).data;
  const txSchema = z.object({
    hash: z.string(),
    blockNumber: z.number().int(),
    timestamp: z.number().int(),
    from: z.string(),
    to: z.string(),
    value: z.union([z.string(), z.number().int().safe()]),
    recipientData: z.string(),
    executionResult: z.boolean(),
  });
  return {
    network: "nimiq:testalbatross",
    token: "native",
    async prepare() {
      if ((await call("isConsensusEstablished")) !== true)
        throw new Error("Nimiq consensus unavailable");
      const head = z
        .object({
          number: z.number().int(),
          network: z.literal("TestAlbatross"),
        })
        .parse(await call("getLatestBlock", [false]));
      return { startBlock: head.number, reference: randomUUID() };
    },
    async find(intent) {
      if ((await call("isConsensusEstablished")) !== true)
        throw new Error("Nimiq consensus unavailable");
      const head = z
        .object({
          number: z.number().int(),
          network: z.literal("TestAlbatross"),
        })
        .parse(await call("getLatestBlock", [false]));
      const finalHeight = z
        .number()
        .int()
        .nonnegative()
        .parse(await call("getLastMacroBlock", [head.number]));
      const macro = z
        .object({
          number: z.number(),
          hash: z.string(),
          type: z.literal("macro"),
        })
        .parse(await call("getBlockByNumber", [finalHeight, false]));
      const found: ChainEvidence[] = [];
      let cursor: string | null = null;
      for (let page = 0; page < 100; page++) {
        const rows = z
          .array(txSchema)
          .parse(
            await call("getTransactionsByAddress", [
              intent.recipient,
              500,
              cursor,
            ]),
          );
        for (const tx of rows) {
          if (
            tx.blockNumber < intent.startBlock ||
            tx.blockNumber > macro.number ||
            tx.recipientData !== Buffer.from(intent.reference).toString("hex")
          )
            continue;
          const canonical = z
            .object({
              hash: z.string(),
              transactions: z.array(z.object({ hash: z.string() })),
            })
            .parse(await call("getBlockByNumber", [tx.blockNumber, true]));
          if (!canonical.transactions.some((t) => t.hash === tx.hash)) continue;
          found.push({
            transaction: tx.hash,
            blockHash: canonical.hash,
            block: tx.blockNumber,
            timestamp: tx.timestamp,
            payer: tx.from,
            recipient: tx.to,
            units: String(tx.value),
            network: "nimiq:testalbatross",
            token: "native",
            reference: Buffer.from(tx.recipientData, "hex").toString(),
            finalized: true,
            success: tx.executionResult,
          });
        }
        if (rows.length < 500 || rows.at(-1)!.blockNumber < intent.startBlock)
          break;
        cursor = rows.at(-1)!.hash;
        if (page === 99)
          throw new Error(
            "Nimiq recovery history exceeds bounded scan; operator required",
          );
      }
      return found;
    },
  };
}
