import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";

export type AlertConfiguration = { apiKey: string; from: string; to: string };
type Status = "healthy" | "degraded";
type Report = "delivery_failed" | "state_unavailable";
const gap = 300_000;
const statusSchema = z.enum(["healthy", "degraded"]);
const timestamp = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const stateSchema = z
  .object({
    version: z.literal(1),
    binding: z.string().regex(/^[a-f0-9]{64}$/),
    observed: statusSchema,
    observedAt: timestamp,
    announced: statusSchema,
    nextSendAt: timestamp,
    pending: z
      .object({
        id: z.string().uuid(),
        status: statusSchema,
        attempted: z.boolean(),
      })
      .strict()
      .optional(),
  })
  .strict();
type State = z.infer<typeof stateSchema>;

export function alertConfiguration(
  env: NodeJS.ProcessEnv = process.env,
): AlertConfiguration | undefined {
  const apiKey = env.RESEND_API_KEY?.trim() ?? "";
  const from = env.EMAIL_FROM?.trim() ?? "";
  const to = env.ALERT_EMAIL_TO?.trim() ?? "";
  if (!apiKey && !from && !to) return undefined;
  const email =
    /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?\.[A-Za-z]{2,63}$/;
  const sender =
    from.match(/^[A-Za-z0-9][A-Za-z0-9 ._-]{0,79} <([^<>]+)>$/)?.[1] ?? from;
  if (
    !/^re_[A-Za-z0-9_-]{8,256}$/.test(apiKey) ||
    from.length > 254 ||
    to.length > 254 ||
    !email.test(sender) ||
    !email.test(to)
  )
    throw new Error(
      "Configure RESEND_API_KEY, EMAIL_FROM and ALERT_EMAIL_TO together with valid email addresses",
    );
  return { apiKey, from, to };
}

export async function sendOperationalAlert(
  config: AlertConfiguration,
  status: Status | "test",
  id: string,
  transport: typeof fetch = fetch,
): Promise<{ accepted: boolean; retryAfterMs?: number }> {
  if (!/^[a-f0-9-]{36}$/.test(id)) throw new Error("Invalid alert identifier");
  const content =
    status === "degraded"
      ? {
          subject: "Handoff service needs attention",
          text: "Handoff's internal service checks are degraded. Review the service's operational health and logs. This alert contains no customer or file information.",
        }
      : status === "healthy"
        ? {
            subject: "Handoff service recovered",
            text: "Handoff's internal service checks have recovered. This confirms the checks inside the running application; it does not verify external reachability or backups.",
          }
        : {
            subject: "Handoff operational alert test",
            text: "This is a requested test of Handoff's operational email alerts. It does not indicate a service incident or verify complete outage monitoring.",
          };
  try {
    const response = await transport("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${config.apiKey}`,
        "Content-Type": "application/json",
        "Idempotency-Key": `handoff-operational/${id}`,
      },
      body: JSON.stringify({ from: config.from, to: [config.to], ...content }),
      redirect: "error",
      signal: AbortSignal.timeout(7000),
    });
    if (!response.ok) {
      const retry = response.headers.get("retry-after");
      const seconds = retry && /^\d+$/.test(retry) ? Number(retry) : 0;
      await response.body?.cancel();
      return {
        accepted: false,
        retryAfterMs: Math.min(3600_000, Math.max(gap, seconds * 1000)),
      };
    }
    if (
      !response.body ||
      !response.headers.get("content-type")?.startsWith("application/json")
    ) {
      await response.body?.cancel();
      return { accepted: false };
    }
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      for (;;) {
        const item = await reader.read();
        if (item.done) break;
        size += item.value.byteLength;
        if (size > 8192) {
          await reader.cancel();
          return { accepted: false };
        }
        chunks.push(item.value);
      }
    } finally {
      reader.releaseLock();
    }
    const data = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    return {
      accepted: typeof data?.id === "string" && /^[a-f0-9-]{36}$/.test(data.id),
    };
  } catch {
    return { accepted: false };
  }
}

export function createAlertMonitor(options: {
  configuration: AlertConfiguration;
  directory: string;
  check: () => Promise<boolean>;
  transport?: typeof fetch;
  now?: () => number;
  report?: (code: Report) => void;
}) {
  const now = options.now ?? Date.now;
  const path = join(options.directory, ".operational-alerts.json");
  const binding = createHash("sha256")
    .update(
      JSON.stringify([options.configuration.from, options.configuration.to]),
    )
    .digest("hex");
  let state: State | undefined;
  let pending: Promise<void> | undefined;
  let checking: Promise<boolean> | undefined;
  let timer: NodeJS.Timeout | undefined;
  let stopped = false;
  let dirty = false;
  let lastReport = -Infinity;
  function report(code: Report) {
    if (now() - lastReport < gap) return;
    lastReport = now();
    options.report?.(code);
  }
  async function persist() {
    const temporary = `${path}.next`;
    try {
      await mkdir(options.directory, { recursive: true, mode: 0o700 });
      const file = await open(temporary, "w", 0o600);
      try {
        await file.writeFile(JSON.stringify(state));
        await file.sync();
      } finally {
        await file.close();
      }
      await rename(temporary, path);
      dirty = false;
    } catch {
      dirty = true;
      report("state_unavailable");
    } finally {
      await rm(temporary, { force: true }).catch(() => {});
    }
  }
  async function check() {
    checking ??= Promise.resolve()
      .then(options.check)
      .catch(() => false)
      .finally(() => {
        checking = undefined;
      });
    let timeout: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([
        checking,
        new Promise<boolean>((resolve) => {
          timeout = setTimeout(() => resolve(false), 10_000);
        }),
      ]);
    } finally {
      clearTimeout(timeout);
    }
  }
  async function run() {
    const current: Status = (await check()) ? "healthy" : "degraded";
    if (stopped) return;
    if (state && dirty) await persist();
    if (!state) {
      try {
        const file = await open(path, "r");
        try {
          if ((await file.stat()).size > 8192)
            throw new Error("Invalid alert state");
          const saved = stateSchema.parse(
            JSON.parse(await file.readFile("utf8")),
          );
          if (saved.binding === binding) state = saved;
        } finally {
          await file.close();
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT")
          report("state_unavailable");
      }
      if (!state) {
        state = {
          version: 1,
          binding,
          observed: current,
          observedAt: now(),
          announced: "healthy",
          nextSendAt: 0,
        };
        await persist();
        return;
      }
    }
    if (state.observed !== current) {
      state.observed = current;
      state.observedAt = now();
      await persist();
    }
    if (now() - state.observedAt < 60_000) return;
    if (state.pending && state.pending.status !== current) {
      const attempted = state.pending.attempted;
      state.pending =
        attempted || state.announced !== current
          ? { id: randomUUID(), status: current, attempted: false }
          : undefined;
      await persist();
    }
    if (!state.pending && state.announced !== current) {
      state.pending = { id: randomUUID(), status: current, attempted: false };
      await persist();
    }
    if (!state.pending || now() < state.nextSendAt || stopped) return;
    state.pending.attempted = true;
    state.nextSendAt = now() + gap;
    await persist();
    if (stopped) return;
    const result = await sendOperationalAlert(
      options.configuration,
      state.pending.status,
      state.pending.id,
      options.transport,
    );
    if (result.accepted) {
      state.announced = state.pending.status;
      state.pending = undefined;
    } else {
      state.nextSendAt = Math.max(
        state.nextSendAt,
        now() + (result.retryAfterMs ?? gap),
      );
      report("delivery_failed");
    }
    await persist();
  }
  function tick() {
    if (stopped) return Promise.resolve();
    pending ??= run()
      .catch(() => report("state_unavailable"))
      .finally(() => {
        pending = undefined;
      });
    return pending;
  }
  return {
    tick,
    start() {
      if (timer || stopped) return;
      void tick();
      timer = setInterval(() => {
        void tick();
      }, 30_000);
      timer.unref();
    },
    async stop() {
      stopped = true;
      clearInterval(timer);
      await pending;
    },
  };
}
