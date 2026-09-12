/**
 * A FlightByte webhook receiver with no dependencies.
 *
 *   FLIGHTBYTE_WEBHOOK_SECRET=whsec_... node node/receiver.mjs
 *
 * Verifies the signature against the raw body, deduplicates on the event id,
 * answers 204 at once, and only then does the work.
 */
import { createHmac, timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";

const SECRET = process.env.FLIGHTBYTE_WEBHOOK_SECRET;
const PORT = Number(process.env.PORT ?? 4599);
const TOLERANCE_SECONDS = 300;

if (!SECRET) {
  console.error("set FLIGHTBYTE_WEBHOOK_SECRET to the secret returned when the subscription was created");
  process.exit(1);
}

/** `t=<unix seconds>,v1=<hex>` where v1 = HMAC-SHA256(secret, `${t}.${rawBody}`). */
export function verify(header, rawBody, secret = SECRET, tolerance = TOLERANCE_SECONDS) {
  if (!header) return false;
  const parts = Object.fromEntries(header.split(",").map((part) => part.split("=", 2)));
  const t = Number(parts.t);
  if (!Number.isFinite(t) || !parts.v1) return false;
  if (Math.abs(Date.now() / 1000 - t) > tolerance) return false;
  const expected = createHmac("sha256", secret).update(`${parts.t}.`).update(rawBody).digest("hex");
  return parts.v1.length === expected.length && timingSafeEqual(Buffer.from(parts.v1), Buffer.from(expected));
}

// In production this is a table keyed by event id; a Set is enough to show the shape.
const seen = new Set();

function handle(event) {
  switch (event.type) {
    case "flight.updated":
      for (const change of event.changes) console.log(`  ${change.type}: ${change.message}`);
      break;
    case "subscription.created":
    case "subscription.activated":
      console.log(`  watching ${event.flightKey ?? "(flight not resolved yet)"}`);
      break;
    case "subscription.completed":
      console.log("  watch ended; archive the booking");
      break;
    case "subscription.suspended":
      console.log("  deliveries kept failing; fix the endpoint and POST /v1/subscriptions/{id}/resume");
      break;
    case "subscription.test":
      console.log("  test event received");
      break;
  }
}

createServer((req, res) => {
  if (req.method !== "POST") {
    res.writeHead(405).end();
    return;
  }
  const chunks = [];
  req.on("data", (chunk) => chunks.push(chunk));
  req.on("end", () => {
    const rawBody = Buffer.concat(chunks);
    if (!verify(req.headers["x-flightbyte-signature"], rawBody)) {
      console.warn("rejected: bad signature");
      res.writeHead(401).end();
      return;
    }

    const event = JSON.parse(rawBody.toString("utf8"));
    if (seen.has(event.id)) {
      // A retry carries the same id and body. Acknowledge it and move on.
      res.writeHead(204).end();
      return;
    }
    seen.add(event.id);

    // Acknowledge first; FlightByte waits ten seconds and then retries.
    res.writeHead(204).end();

    const attempt = req.headers["x-flightbyte-delivery-attempt"];
    console.log(`[${event.type}] ${event.flightKey ?? ""} attempt ${attempt} booking ${event.metadata?.bookingId ?? "-"}`);
    setImmediate(() => handle(event));
  });
}).listen(PORT, () => console.log(`receiving FlightByte webhooks on http://localhost:${PORT}`));
