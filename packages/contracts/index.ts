import { z } from 'zod';

export const currencySchema = z.enum(['NIM', 'USDT']);
export const draftSchema = z.object({
  title: z.string().trim().min(1).max(100),
  description: z.string().trim().max(2000),
  clientLabel: z.string().trim().min(1).max(100),
  currency: currencySchema,
  amount: z.string().regex(/^\d{1,9}(\.\d{1,6})?$/).refine(v => Number(v) > 0, 'Enter an amount above zero'),
  terms: z.string().trim().min(1).max(2000),
  deadline: z.string().datetime(),
}).superRefine((value, ctx) => {
  if (value.currency === 'NIM' && (value.amount.split('.')[1]?.length ?? 0) > 5) ctx.addIssue({ code: 'custom', path: ['amount'], message: 'NIM supports up to five decimal places' });
});
export type DraftInput = z.infer<typeof draftSchema>;
export type Currency = z.infer<typeof currencySchema>;
export type FileRecord = { id: string; name: string; bytes: number; mime: string; sha256: string; previewSha256: string; scan: 'clean' | 'quarantined'; approved: boolean };
export type Handoff = DraftInput & { id: string; creator: string; clientWallet: string | null; status: 'draft' | 'awaiting-client' | 'ready'; createdAt: string; publishedAt: string | null; manifestHash: string | null; files: FileRecord[] };
export type Session = { address: string; currency: Currency };
export type PublicHandoff = Omit<Handoff, 'clientLabel' | 'clientWallet'> & { checkoutEnabled: false; downloadDays: number };
