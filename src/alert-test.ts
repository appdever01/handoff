import { randomUUID } from "node:crypto";
import { alertConfiguration, sendOperationalAlert } from "./alerts.ts";

try {
  if (process.argv.slice(2).join(" ") !== "--send-test")
    throw new Error(
      "Run with --send-test only when an operator has requested a real test email",
    );
  const configuration = alertConfiguration();
  if (!configuration)
    throw new Error(
      "Configure RESEND_API_KEY, EMAIL_FROM and ALERT_EMAIL_TO first",
    );
  const id = process.env.ALERT_TEST_ID ?? randomUUID();
  if (!/^[a-f0-9-]{36}$/.test(id)) throw new Error("Invalid ALERT_TEST_ID");
  console.log(`Operational test reference: ${id}`);
  const result = await sendOperationalAlert(configuration, "test", id);
  if (!result.accepted)
    throw new Error(
      "Resend did not confirm acceptance of the test email; inspect the provider dashboard before retrying",
    );
  console.log(
    "Resend accepted the requested operational test email. Verify receipt in the configured mailbox.",
  );
} catch (error) {
  console.error((error as Error).message);
  process.exitCode = 1;
}
