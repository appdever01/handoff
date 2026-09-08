import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import {
  alertConfiguration,
  createAlertMonitor,
  sendOperationalAlert,
} from "../src/alerts.ts";

const env = {
  RESEND_API_KEY: "re_test_value_never_real",
  EMAIL_FROM: "Handoff <health@example.com>",
  ALERT_EMAIL_TO: "operator@example.com",
};
const configuration = alertConfiguration(env)!;
const accepted = () =>
  new Response(JSON.stringify({ id: randomUUID() }), {
    headers: { "content-type": "application/json" },
  });

test("alerts are disabled by default and configuration requires a safe complete sender/recipient", () => {
  assert.equal(alertConfiguration({}), undefined);
  assert.equal(
    alertConfiguration({
      RESEND_API_KEY: "",
      EMAIL_FROM: "",
      ALERT_EMAIL_TO: "",
    }),
    undefined,
  );
  assert.deepEqual(configuration, {
    apiKey: env.RESEND_API_KEY,
    from: env.EMAIL_FROM,
    to: env.ALERT_EMAIL_TO,
  });
  for (const change of [
    { RESEND_API_KEY: "" },
    { EMAIL_FROM: "" },
    { ALERT_EMAIL_TO: "" },
    { EMAIL_FROM: "sender@example.com\r\nBcc:someone@example.com" },
    { ALERT_EMAIL_TO: "one@example.com,two@example.com" },
    { RESEND_API_KEY: "not-a-resend-key" },
  ])
    assert.throws(
      () => alertConfiguration({ ...env, ...change }),
      /Configure RESEND_API_KEY/,
    );
});

test("provider requests have fixed generic content, deadlines and idempotency without leaking errors", async () => {
  const id = randomUUID();
  const transport: typeof fetch = async (url, init) => {
    assert.equal(url, "https://api.resend.com/emails");
    assert.equal(init?.redirect, "error");
    assert.ok(init?.signal);
    assert.deepEqual(init?.headers, {
      Authorization: `Bearer ${configuration.apiKey}`,
      "Content-Type": "application/json",
      "Idempotency-Key": `handoff-operational/${id}`,
    });
    const body = JSON.parse(String(init?.body));
    assert.deepEqual(Object.keys(body).sort(), [
      "from",
      "subject",
      "text",
      "to",
    ]);
    assert.deepEqual(body.to, [configuration.to]);
    assert.equal(body.from, configuration.from);
    assert.match(body.subject, /needs attention/);
    assert.doesNotMatch(
      body.text,
      /re_test_value|operator@example|https:|wallet address/,
    );
    return accepted();
  };
  assert.deepEqual(
    await sendOperationalAlert(configuration, "degraded", id, transport),
    { accepted: true },
  );
  assert.deepEqual(
    await sendOperationalAlert(configuration, "healthy", id, async () => {
      throw new Error("private credential response");
    }),
    { accepted: false },
  );
  assert.deepEqual(
    await sendOperationalAlert(
      configuration,
      "healthy",
      id,
      async () =>
        new Response("secret body", {
          status: 429,
          headers: { "retry-after": "900" },
        }),
    ),
    { accepted: false, retryAfterMs: 900_000 },
  );
  assert.deepEqual(
    await sendOperationalAlert(
      configuration,
      "test",
      id,
      async () =>
        new Response("x".repeat(9000), {
          headers: { "content-type": "application/json" },
        }),
    ),
    { accepted: false },
  );
});

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "handoff-alerts-"));
  let time = 1_000_000;
  let healthy = true;
  let fail = false;
  const sent: { body: string; key: string }[] = [];
  const options = {
    directory,
    configuration,
    now: () => time,
    check: async () => healthy,
    transport: (async (_url, init) => {
      sent.push({
        body: String(init?.body),
        key: (init!.headers as Record<string, string>)["Idempotency-Key"],
      });
      if (fail) throw new Error("uncertain send");
      return accepted();
    }) as typeof fetch,
  };
  return {
    directory,
    options,
    sent,
    advance: (amount: number) => {
      time += amount;
    },
    health: (value: boolean) => {
      healthy = value;
    },
    fail: (value: boolean) => {
      fail = value;
    },
    close: () => rm(directory, { recursive: true, force: true }),
  };
}

test("stable transitions alert once, suppress healthy startup, persist dedupe and rate-limit recovery", async () => {
  const f = await fixture();
  let monitor = createAlertMonitor(f.options);
  try {
    await monitor.tick();
    f.advance(100_000);
    await monitor.tick();
    assert.equal(f.sent.length, 0);
    f.health(false);
    await monitor.tick();
    f.advance(59_999);
    await monitor.tick();
    assert.equal(f.sent.length, 0);
    f.advance(1);
    await Promise.all([monitor.tick(), monitor.tick(), monitor.tick()]);
    assert.equal(f.sent.length, 1);
    assert.match(f.sent[0].body, /needs attention/);
    await monitor.stop();
    monitor = createAlertMonitor(f.options);
    f.advance(60_000);
    await monitor.tick();
    assert.equal(f.sent.length, 1);
    f.health(true);
    await monitor.tick();
    f.advance(60_000);
    await monitor.tick();
    assert.equal(f.sent.length, 1);
    f.advance(180_000);
    await monitor.tick();
    assert.equal(f.sent.length, 2);
    assert.match(f.sent[1].body, /recovered/);
    const state = await readFile(
      join(f.directory, ".operational-alerts.json"),
      "utf8",
    );
    assert.doesNotMatch(state, /example.com|re_test_value|subject|text/);
    assert.equal(JSON.parse(state).pending, undefined);
  } finally {
    await monitor.stop();
    await f.close();
  }
});

test("an uncertain send retries the same durable request after restart and respects cooldown", async () => {
  const f = await fixture();
  let monitor = createAlertMonitor(f.options);
  try {
    f.health(false);
    f.fail(true);
    await monitor.tick();
    f.advance(60_000);
    await monitor.tick();
    assert.equal(f.sent.length, 1);
    await monitor.stop();
    monitor = createAlertMonitor(f.options);
    await monitor.tick();
    assert.equal(f.sent.length, 1);
    f.advance(300_000);
    f.fail(false);
    await monitor.tick();
    assert.equal(f.sent.length, 2);
    assert.deepEqual(f.sent[0], f.sent[1]);
    f.advance(3600_000);
    await monitor.tick();
    assert.equal(f.sent.length, 2);
  } finally {
    await monitor.stop();
    await f.close();
  }
});

test("transient changes are coalesced and obsolete failed alerts are replaced with stable recovery", async () => {
  const f = await fixture();
  const monitor = createAlertMonitor(f.options);
  try {
    await monitor.tick();
    f.health(false);
    await monitor.tick();
    f.advance(30_000);
    f.health(true);
    await monitor.tick();
    f.advance(60_000);
    await monitor.tick();
    assert.equal(f.sent.length, 0);
    f.health(false);
    f.fail(true);
    await monitor.tick();
    f.advance(60_000);
    await monitor.tick();
    f.health(true);
    await monitor.tick();
    f.advance(300_000);
    f.fail(false);
    await monitor.tick();
    assert.equal(f.sent.length, 2);
    assert.match(f.sent[1].body, /recovered/);
    assert.notEqual(f.sent[0].key, f.sent[1].key);
  } finally {
    await monitor.stop();
    await f.close();
  }
});

test("unwritable state storage still sends a bounded degraded alert and dedupes in memory", async () => {
  const f = await fixture();
  const blocked = join(f.directory, "not-a-directory");
  await writeFile(blocked, "fixture");
  const reports: string[] = [];
  const monitor = createAlertMonitor({
    ...f.options,
    directory: blocked,
    report: (code) => reports.push(code),
  });
  try {
    f.health(false);
    await monitor.tick();
    f.advance(60_000);
    await monitor.tick();
    assert.equal(f.sent.length, 1);
    assert.deepEqual(reports, ["state_unavailable"]);
    f.advance(600_000);
    await monitor.tick();
    assert.equal(f.sent.length, 1);
    await rm(blocked);
    f.advance(30_000);
    await monitor.tick();
    assert.equal(
      JSON.parse(
        await readFile(join(blocked, ".operational-alerts.json"), "utf8"),
      ).announced,
      "degraded",
    );
    f.health(true);
    await monitor.tick();
    f.advance(60_000);
    await monitor.tick();
    assert.equal(f.sent.length, 2);
  } finally {
    await monitor.stop();
    await f.close();
  }
});

test("hung internal probes time out without overlapping checks or blocking shutdown indefinitely", async (t) => {
  const f = await fixture();
  let checks = 0;
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const monitor = createAlertMonitor({
    ...f.options,
    check: () => {
      checks++;
      return new Promise<boolean>(() => {});
    },
  });
  try {
    const first = monitor.tick();
    await Promise.resolve();
    t.mock.timers.tick(10_000);
    await first;
    f.advance(60_000);
    const second = monitor.tick();
    await Promise.resolve();
    const stopping = monitor.stop();
    t.mock.timers.tick(10_000);
    await second;
    await stopping;
    assert.equal(checks, 1);
    assert.equal(f.sent.length, 0);
  } finally {
    await monitor.stop();
    await f.close();
  }
});
