import { z } from "zod";

export const currencySchema = z.enum(["NIM", "USDT"]);
export const draftSchema = z
  .object({
    title: z.string().trim().min(1).max(100),
    description: z.string().trim().max(2000),
    clientLabel: z.string().trim().min(1).max(100),
    currency: currencySchema,
    amount: z
      .string()
      .regex(/^\d{1,9}(\.\d{1,6})?$/)
      .refine((v) => Number(v) > 0, "Enter an amount above zero"),
    terms: z.string().trim().min(1).max(2000),
    deadline: z.string().datetime(),
  })
  .superRefine((value, ctx) => {
    if (
      value.currency === "NIM" &&
      (value.amount.split(".")[1]?.length ?? 0) > 5
    )
      ctx.addIssue({
        code: "custom",
        path: ["amount"],
        message: "NIM supports up to five decimal places",
      });
  });
export type DraftInput = z.infer<typeof draftSchema>;
export type Currency = z.infer<typeof currencySchema>;
export type FileRecord = {
  id: string;
  name: string;
  bytes: number;
  mime: string;
  sha256: string;
  previewSha256: string;
  previewMime?: string;
  scan: "clean" | "quarantined";
  approved: boolean;
  suppliedPreviewRequired?: boolean;
};
export type Handoff = DraftInput & {
  id: string;
  creator: string;
  clientWallet: string | null;
  status: "draft" | "awaiting-client" | "ready" | "paid" | "payment-pending";
  createdAt: string;
  publishedAt: string | null;
  manifestHash: string | null;
  files: FileRecord[];
};
export type Session = {
  address: string;
  currency: Currency;
  scope?: "upload" | "download";
};
export type PublicHandoff = Omit<Handoff, "clientLabel" | "clientWallet"> & {
  checkoutEnabled: boolean;
  downloadDays: number;
};
export type PaymentIntent = {
  id: string;
  handoff: string;
  currency: Currency;
  manifestHash: string;
  payer: string;
  recipient: string;
  units: string;
  network: string;
  token: string;
  startBlock: number;
  reference: string;
  createdAt: number;
  expiresAt: number;
};
export type Receipt = {
  handoff: string;
  intent: string;
  title: string;
  manifestHash: string;
  payer: string;
  recipient: string;
  currency: Currency;
  units: string;
  network: string;
  token: string;
  transaction: string;
  blockHash: string;
  block: number;
  paidAt: number;
  verifiedAt: number;
  expiresAt: number;
};
