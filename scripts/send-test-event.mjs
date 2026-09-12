#!/usr/bin/env node
/**
 * Signs a fixture the way FlightByte does and POSTs it to a receiver, so you
 * can exercise a receiver without an API key or a real flight.
 *
 *   FLIGHTBYTE_WEBHOOK_SECRET=whsec_test node scripts/send-test-event.mjs http://localhost:4599/hooks/flights
 *
 * Options:
 *   --fixture <path>   event body to send (default fixtures/flight.updated.json)
 *   --tamper           flip a byte after signing, to see the receiver reject it
 *   --stale            sign with a timestamp ten minutes old, to see the replay check work
 *   --attempt <n>      value for x-flightbyte-delivery-attempt (default 1)
 */
import { createHmac, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const args = process.argv.slice(2);
const url = args.find((a) => !a.startsWith("--") && !isValueOf(args, a));
const flag = (name) => args.includes(`--${name}`);
const value = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i === -1 ? fallback : args[i + 1];
};
function isValueOf(list, a) {
  const i = list.indexOf(a);
  return i > 0 && ["--fixture", "--attempt"].includes(list[i - 1]);
}

const secret = process.env.FLIGHTBYTE_WEBHOOK_SECRET;
if (!url || !secret) {
  console.error("usage: FLIGHTBYTE_WEBHOOK_SECRET=... node scripts/send-test-event.mjs <receiver url> [--fixture path] [--tamper] [--stale] [--attempt n]");
  process.exit(1);
}

const here = dirname(fileURLToPath(import.meta.url));
const fixturePath = resolve(here, "..", value("fixture", "fixtures/flight.updated.json"));
const event = JSON.parse(await readFile(fixturePath, "utf8"));
// A fresh id per run, so a receiver that deduplicates does not swallow the second send.
if (!flag("attempt")) event.id = `evt_${randomUUID()}`;
const body = JSON.stringify(event);

const t = Math.floor(Date.now() / 1000) - (flag("stale") ? 600 : 0);
const v1 = createHmac("sha256", secret).update(`${t}.${body}`).digest("hex");
const sent = flag("tamper") ? body.replace('"flight.updated"', '"flight.deleted"') : body;

const headers = {
  "content-type": "application/json",
  "user-agent": "flightbyte-webhooks/1.0",
  "x-flightbyte-event-id": event.id,
  "x-flightbyte-event-type": event.type,
  "x-flightbyte-subscription-id": event.subscriptionId,
  "x-flightbyte-delivery-attempt": String(value("attempt", 1)),
  "x-flightbyte-timestamp": String(t),
  "x-flightbyte-signature": `t=${t},v1=${v1}`,
};

const started = performance.now();
const res = await fetch(url, { method: "POST", headers, body: sent });
const ms = Math.round(performance.now() - started);
const text = await res.text();
console.log(`${res.status} ${res.statusText || ""} in ${ms}ms${text ? `  ${text.trim()}` : ""}`);
process.exit(res.ok ? 0 : 2);
