import { createHash } from 'node:crypto';
import { PublicKey, Signature } from '@nimiq/core';
import { getAddress, recoverMessageAddress } from 'viem';
import { z } from 'zod';
import type { Session } from '../packages/contracts/index.ts';

export const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
export const proofSchema = z.discriminatedUnion('currency', [
  z.object({ currency: z.literal('NIM'), challengeId: z.string().uuid(), publicKey: z.string().regex(/^[a-fA-F0-9]{64}$/), signature: z.string().regex(/^[a-fA-F0-9]{128}$/) }),
  z.object({ currency: z.literal('USDT'), challengeId: z.string().uuid(), signature: z.string().regex(/^0x[a-fA-F0-9]{130}$/) }),
]);

export async function verifyProof(message: string, proof: z.infer<typeof proofSchema>): Promise<Session> {
  if (proof.currency === 'USDT') {
    const address = await recoverMessageAddress({ message, signature: proof.signature as `0x${string}` });
    return { currency: 'USDT', address: getAddress(address) };
  }
  const publicKey = new PublicKey(Buffer.from(proof.publicKey, 'hex'));
  const signature = Signature.fromHex(proof.signature);
  const bytes = Buffer.from(message, 'utf8');
  const digest = createHash('sha256').update(Buffer.concat([Buffer.from('\x16Nimiq Signed Message:\n' + bytes.length), bytes])).digest();
  if (!publicKey.verify(signature, digest)) throw new Error('Invalid signature');
  return { currency: 'NIM', address: publicKey.toAddress().toUserFriendlyAddress() };
}
