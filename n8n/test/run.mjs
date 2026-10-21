#!/usr/bin/env node
/**
 * Runs both n8n templates on a real n8n in Docker and checks what they do:
 * the forms' requests to FlightByte, the signature check, the dedupe, and who
 * is told what for each kind of change.
 *
 *   node n8n/test/run.mjs           # build n8n/workflows/ first: node n8n/build.mjs
 *   node n8n/test/run.mjs --keep    # leave n8n running afterwards, to look around
 *
 * Needs Docker and nothing else. Slack, SendGrid, Twilio and the FlightByte API
 * are replaced by a stub this script runs (see test-copy.mjs), so no account
 * or key is involved. Events are signed here the way FlightByte signs them.
 */
import { execFileSync } from "node:child_process";
import { createHmac, randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { CREDENTIALS, testCopy } from "./test-copy.mjs";

const IMAGE = process.env.N8N_IMAGE ?? "docker.n8n.io/n8nio/n8n:2.44.4";
const N8N_PORT = Number(process.env.N8N_PORT ?? 5690);
const STUB_PORT = Number(process.env.STUB_PORT ?? 4690);
// Docker Desktop reaches the host's loopback; on Linux the container comes in through the bridge.
const STUB_HOST = process.platform === "linux" ? "0.0.0.0" : "127.0.0.1";
// n8n builds the subscription's webhookUrl from this, as it would on a public host.
const PUBLIC_URL = "https://n8n.example.com/";
const KEEP = process.argv.includes("--keep");

const here = dirname(fileURLToPath(import.meta.url));
const n8nDir = resolve(here, "..");
const local = `http://127.0.0.1:${N8N_PORT}`;
const SECRET = `whsec_${randomBytes(24).toString("hex")}`;
const API_KEY = `fb_test_${randomBytes(8).toString("hex")}`;
const SUB = "sub_n8n_test";

// ── Stub: FlightByte's POST /v1/subscriptions, and stand-ins for Slack, SendGrid and Twilio

const seen = [];
let lastSeenAt = 0;
const stub = http.createServer((req, res) => {
  let raw = "";
  req.on("data", (chunk) => (raw += chunk));
  req.on("end", () => {
    const body = raw ? JSON.parse(raw) : null;
    seen.push({ path: req.url, headers: req.headers, body });
    lastSeenAt = Date.now();
    if (req.url === "/v1/subscriptions") {
      if (body.flightNumber === "9999") {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ statusCode: 400, error: "BadRequestException", message: `No ${body.carrier}9999 operating on ${body.date}.` }));
        return;
      }
      res.writeHead(201, { "content-type": "application/json" });
      res.end(JSON.stringify({ id: SUB, status: "active", carrier: body.carrier, flightNumber: body.flightNumber, date: body.date }));
      return;
    }
    res.writeHead(200, { "content-type": "application/json" }).end("{}");
  });
});

/** Waits until the workflow has gone quiet, then hands back what reached the stub. */
async function drain() {
  const started = Date.now();
  while (Date.now() - started < 8000) {
    await sleep(250);
    if (Date.now() - started > 1500 && Date.now() - Math.max(lastSeenAt, started) > 1200) break;
  }
  return seen.splice(0);
}

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

// ── n8n in Docker

const docker = (...args) => execFileSync("docker", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
const tag = `flightbyte-n8n-test-${process.pid}`;
const work = mkdtempSync(join(tmpdir(), "flightbyte-n8n-"));

function prepare() {
  const stubUrl = `http://host.docker.internal:${STUB_PORT}`;
  const workflows = [
    ["alerts", "fbAlertsTest0001", "flight-change-alerts.json"],
    ["pickup", "fbPickupTest0001", "airport-pickup.json"],
  ];
  for (const [name, id, file] of workflows) {
    const workflow = JSON.parse(readFileSync(join(n8nDir, "workflows", file), "utf8"));
    writeFileSync(join(work, `${name}.json`), JSON.stringify(testCopy(workflow, { id, stub: stubUrl })));
  }
  writeFileSync(
    join(work, "credentials.json"),
    JSON.stringify([
      { ...CREDENTIALS.crypto, type: "crypto", data: { hmacSecret: SECRET } },
      { ...CREDENTIALS.httpCustomAuth, type: "httpCustomAuth", data: { json: JSON.stringify({ headers: { "x-api-key": API_KEY }, body: { secret: SECRET } }) } },
    ]),
  );
  // Import and publish before the server starts, so it comes up with both workflows live.
  const steps = [
    "n8n import:credentials --input=/work/credentials.json",
    ...workflows.flatMap(([name, id]) => [`n8n import:workflow --input=/work/${name}.json`, `n8n publish:workflow --id=${id}`]),
  ];
  docker("volume", "create", tag);
  docker("run", "--rm", "--entrypoint", "sh", "-v", `${tag}:/home/node/.n8n`, "-v", `${work}:/work:ro`, IMAGE, "-c", steps.join(" && "));
  docker(
    "run", "-d", "--name", tag,
    "-p", `127.0.0.1:${N8N_PORT}:5678`,
    "--add-host=host.docker.internal:host-gateway",
    "-v", `${tag}:/home/node/.n8n`,
    "-e", `WEBHOOK_URL=${PUBLIC_URL}`,
    "-e", "N8N_DIAGNOSTICS_ENABLED=false",
    "-e", "N8N_PERSONALIZATION_ENABLED=false",
    IMAGE,
  );
}

async function waitForN8n() {
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    const [alerts, pickup] = await Promise.all([
      send("alerts", event("subscription.created")).catch(() => ({ status: 0 })),
      send("pickup", event("subscription.created")).catch(() => ({ status: 0 })),
    ]);
    if (alerts.status === 204 && pickup.status === 204) return drain();
    await sleep(1000);
  }
  throw new Error("n8n did not answer on both webhooks within two minutes");
}

function cleanUp() {
  stub.close();
  rmSync(work, { recursive: true, force: true });
  if (KEEP) {
    console.log(`\nn8n is still running at ${local} (container ${tag}). Remove it with:\n  docker rm -f ${tag} && docker volume rm ${tag}`);
    return;
  }
  for (const args of [["rm", "-f", tag], ["volume", "rm", tag]]) {
    try {
      docker(...args);
    } catch {
      /* already gone */
    }
  }
}

// ── Events, signed the way FlightByte signs them

const base = JSON.parse(readFileSync(resolve(n8nDir, "..", "fixtures", "flight.updated.json"), "utf8"));
const tk1 = JSON.parse(readFileSync(join(here, "fixtures", "tk1-snapshot.json"), "utf8"));

function event(type, changes = [], { flight = base.flight, metadata = { bookingRef: "BK-1042" }, subscriptionId = SUB } = {}) {
  return { ...base, id: `evt_${randomUUID()}`, type, subscriptionId, flight: structuredClone(flight), changes, metadata };
}

async function send(workflow, body, { tamper = false, stale = false } = {}) {
  const raw = JSON.stringify(body);
  const t = Math.floor(Date.now() / 1000) - (stale ? 600 : 0);
  const v1 = createHmac("sha256", SECRET).update(`${t}.${raw}`).digest("hex");
  const res = await fetch(`${local}/webhook/flightbyte-${workflow}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-flightbyte-event-id": body.id,
      "x-flightbyte-event-type": body.type,
      "x-flightbyte-subscription-id": body.subscriptionId,
      "x-flightbyte-delivery-attempt": "1",
      "x-flightbyte-timestamp": String(t),
      "x-flightbyte-signature": `t=${t},v1=${v1}`,
    },
    body: tamper ? raw.replace("Istanbul", "Ankara") : raw,
  });
  return { status: res.status };
}

async function submitForm(path, values) {
  const form = new FormData();
  values.forEach((value, index) => form.append(`field-${index}`, value));
  const res = await fetch(`${local}/form/${path}`, { method: "POST", body: form });
  const { formWaitingUrl } = await res.json();
  await sleep(2500);
  // The done page's address carries WEBHOOK_URL's host; read it from here.
  const page = await (await fetch(formWaitingUrl.replace(PUBLIC_URL, `${local}/`))).text();
  return {
    title: page.match(/<h1[^>]*>([^<]*)/)?.[1]?.trim() ?? "",
    message: page.match(/pre-line;">([^<]*)/)?.[1]?.trim() ?? "",
  };
}

const change = (type, path, from, to, extra = {}) => ({ type, path, from, to, message: `${type} from ${from} to ${to}`, ...extra });

// ── Checks

let failures = 0;
function check(label, ok, detail = "") {
  console.log(`${ok ? "  ✓" : "  ✗"} ${label}${ok || !detail ? "" : `\n      ${detail}`}`);
  if (!ok) failures += 1;
}
const told = (captured) => captured.filter((r) => r.path === "/capture").map((r) => r.body);
const nodes = (captured) => told(captured).map((m) => m.node).sort();
const same = (a, b) => JSON.stringify([...a].sort()) === JSON.stringify([...b].sort());
const message = (captured, node) => told(captured).find((m) => m.node === node) ?? {};

async function expectTold(label, workflow, body, expected, extraChecks = () => {}, options = {}) {
  const { status } = await send(workflow, body, options);
  const captured = await drain();
  const expectStatus = options.tamper || options.stale ? 401 : 204;
  check(`${label}: answers ${expectStatus}`, status === expectStatus, `got ${status}`);
  check(`${label}: tells ${expected.length ? expected.join(", ") : "nobody"}`, same(nodes(captured), expected), `got ${nodes(captured).join(", ") || "nobody"}`);
  extraChecks(captured);
}

async function main() {
  await new Promise((ready) => stub.listen(STUB_PORT, STUB_HOST, ready));
  console.log(`Starting ${IMAGE} …`);
  prepare();
  await waitForN8n();

  console.log("\nForms");
  const watched = await submitForm("watch-a-flight", ["tk 1848", "2026-10-22", "", "Ayşe Yılmaz", "ayse@example.com", "+905321234567", "BK-1042"]);
  let captured = await drain();
  const create = captured.find((r) => r.path === "/v1/subscriptions");
  check("alerts form: calls POST /v1/subscriptions", Boolean(create));
  check("alerts form: sends the key from the credential", create?.headers["x-api-key"] === API_KEY);
  check(
    "alerts form: sends flight, own webhook, booking ref and secret",
    same(Object.keys(create?.body ?? {}), ["carrier", "flightNumber", "date", "webhookUrl", "metadata", "secret"]) &&
      create.body.carrier === "TK" &&
      create.body.flightNumber === "1848" &&
      create.body.date === "2026-10-22" &&
      create.body.webhookUrl === `${PUBLIC_URL}webhook/flightbyte-alerts` &&
      create.body.metadata?.bookingRef === "BK-1042" &&
      create.body.secret === SECRET,
    JSON.stringify(create?.body),
  );
  check("alerts form: keeps contact details out of FlightByte", !JSON.stringify(create?.body ?? {}).match(/ayse|\+90532|Yılmaz/));
  check("alerts form: done page names the flight", watched.title === "Watching TK1848 on 2026-10-22", watched.title);
  check("alerts form: done page shows the subscription id", watched.message.includes(`Subscription ${SUB}`), watched.message);

  const booked = await submitForm("book-a-pickup", ["TK1848", "2026-10-22", "ath", "Ayşe Yılmaz", "+905329876543"]);
  captured = await drain();
  const pickupCreate = captured.find((r) => r.path === "/v1/subscriptions")?.body ?? {};
  check("pickup form: picks the leg with origin", pickupCreate.origin === "ATH", JSON.stringify(pickupCreate));
  check("pickup form: asks for arrival changes only", pickupCreate.events?.length === 7 && pickupCreate.events.includes("arrival.baggage.changed"));
  check("pickup form: sends no metadata", !("metadata" in pickupCreate));
  check("pickup form: done page names the flight", booked.title === "Watching TK1848 on 2026-10-22", booked.title);

  const refused = await submitForm("watch-a-flight", ["TK9999", "2026-10-22", "", "", "", "", ""]);
  await drain();
  check("alerts form: shows FlightByte's error", refused.title === "Could not watch this flight" && refused.message.includes("No TK9999"), `${refused.title} / ${refused.message}`);

  console.log("\nFlight change alerts");
  const SLACK = "Post to Slack";
  const EMAIL = "Email the passenger";
  const SMS = "Text the passenger";
  await expectTold(
    "gate change",
    "alerts",
    event("flight.updated", base.changes),
    [SLACK, EMAIL],
    (c) => {
      check("gate change: Slack names the gate and the booking", /Departure gate is now A22 \(was A11\)/.test(message(c, SLACK).text) && message(c, SLACK).text.includes("(booking BK-1042)"), message(c, SLACK).text);
      check("gate change: email goes to the passenger in the table", message(c, EMAIL).to === "ayse@example.com" && message(c, EMAIL).text.startsWith("Hi Ayşe Yılmaz,"));
      check("gate change: times are local to the airport", message(c, SLACK).text.includes("Arrival time (estimated) is now 14:15, was 13:45"), message(c, SLACK).text);
    },
  );
  await expectTold(
    "cancellation",
    "alerts",
    event("flight.updated", [change("status.changed", "status.phase", "scheduled", "cancelled"), change("flight.cancelled", "status.cancelled", false, true)]),
    [SLACK, EMAIL, SMS],
    (c) => {
      check("cancellation: SMS says so", message(c, SMS).message === "TK1848 Athens to Istanbul on 12 Sep is cancelled." && message(c, SMS).to === "+905321234567", JSON.stringify(message(c, SMS)));
      check("cancellation: no separate status line", !message(c, SLACK).text?.includes("status.changed"), message(c, SLACK).text);
    },
  );
  await expectTold(
    "arrival delay of 75 minutes",
    "alerts",
    event("flight.updated", [
      change("arrival.estimated.changed", "arrival.times.estimatedGate", "2026-09-12T11:05:00Z", "2026-09-12T12:00:00Z", { deltaMinutes: 55 }),
      change("arrival.estimated.changed", "arrival.times.estimatedRunway", "2026-09-12T10:55:00Z", "2026-09-12T11:50:00Z", { deltaMinutes: 55 }),
      change("delay.increased", "status.arrivalGateDelayMinutes", 20, 75, { deltaMinutes: 55 }),
    ]),
    [SLACK, EMAIL, SMS],
    (c) => {
      check("delay: SMS names the delay", message(c, SMS).message?.endsWith("Arrival delay is now 75 minutes."), message(c, SMS).message);
      check("delay: runway time folded into the gate time", !message(c, SLACK).text?.includes("runway"), message(c, SLACK).text);
    },
  );
  await expectTold("baggage belt only", "alerts", event("flight.updated", [change("arrival.baggage.changed", "arrival.baggage", null, "7")]), [SLACK]);
  await expectTold(
    "real TK1 snapshot",
    "alerts",
    event("flight.updated", [change("arrival.estimated.changed", "arrival.times.estimatedGate", "2026-10-21T21:55:00.000Z", "2026-10-21T21:45:00.000Z", { deltaMinutes: -10 })], { flight: tk1 }),
    [SLACK],
    (c) => check("real TK1 snapshot: Istanbul and New York clocks", message(c, SLACK).text?.includes("TK1 Istanbul to New York, 21 Oct: departs 14:00, gate D12") && message(c, SLACK).text.includes("is now 17:45, was 17:55"), message(c, SLACK).text),
  );
  await expectTold("test event", "alerts", event("subscription.test"), ["Confirm the test event"]);
  await expectTold("suspended watch", "alerts", event("subscription.suspended"), ["Warn about the suspended watch"]);
  await expectTold("subscription created", "alerts", event("subscription.created"), []);
  await expectTold("tampered body", "alerts", event("flight.updated", base.changes), [], undefined, { tamper: true });
  await expectTold("timestamp ten minutes old", "alerts", event("flight.updated", base.changes), [], undefined, { stale: true });
  const retried = event("flight.updated", base.changes);
  await expectTold("first delivery", "alerts", retried, [SLACK, EMAIL]);
  await expectTold("retry of the same event", "alerts", retried, []);
  await expectTold(
    "flight watched some other way",
    "alerts",
    event("flight.updated", [change("flight.cancelled", "status.cancelled", false, true)], { subscriptionId: "sub_unknown" }),
    [SLACK],
  );

  console.log("\nAirport pickup");
  const DRIVER = "Text the driver";
  const pickupEvent = (changes, flight) => event("flight.updated", changes, { flight, metadata: {} });
  await expectTold("departed", "pickup", pickupEvent([change("flight.departed", "status.phase", "boarding", "departed")]), [DRIVER], (c) =>
    check("departed: driver text", message(c, DRIVER).message === "TK1848 has left Athens. Lands about 14:15 at IST. Passenger: Ayşe Yılmaz." && message(c, DRIVER).to === "+905329876543", JSON.stringify(message(c, DRIVER))),
  );
  await expectTold("landing time moves 5 minutes", "pickup", pickupEvent([change("arrival.estimated.changed", "arrival.times.estimatedGate", "2026-09-12T11:15:00Z", "2026-09-12T11:20:00Z", { deltaMinutes: 5 })]), []);
  const later = structuredClone(base.flight);
  later.arrival.times.estimatedGate.utc = "2026-09-12T11:40:00Z";
  await expectTold("landing time moves 25 minutes", "pickup", pickupEvent([change("arrival.estimated.changed", "arrival.times.estimatedGate", "2026-09-12T11:15:00Z", "2026-09-12T11:40:00Z", { deltaMinutes: 25 })], later), [DRIVER], (c) =>
    check("25 minutes: driver text", message(c, DRIVER).message?.startsWith("TK1848 now lands about 14:40 at IST (was 14:15)."), message(c, DRIVER).message),
  );
  const atGate = structuredClone(base.flight);
  atGate.arrival.terminal = "1";
  await expectTold("at the gate with a belt", "pickup", pickupEvent([change("flight.arrived", "status.phase", "landed", "arrived"), change("arrival.baggage.changed", "arrival.baggage", null, "7")], atGate), [DRIVER], (c) =>
    check("at the gate: driver text", message(c, DRIVER).message?.startsWith("TK1848 is at the gate at IST, terminal 1. Bags on belt 7."), message(c, DRIVER).message),
  );
  await expectTold("cancelled", "pickup", pickupEvent([change("flight.cancelled", "status.cancelled", false, true)]), [DRIVER], (c) =>
    check("cancelled: driver text", message(c, DRIVER).message?.startsWith("TK1848 from Athens is cancelled. Pickup on hold."), message(c, DRIVER).message),
  );
  await expectTold("tampered body", "pickup", pickupEvent([change("flight.departed", "status.phase", "boarding", "departed")]), [], undefined, { tamper: true });

  console.log("\nAfter the flight");
  await expectTold("alerts: watch completed", "alerts", event("subscription.completed"), []);
  await expectTold("alerts: a later change reaches Slack only", "alerts", event("flight.updated", [change("flight.cancelled", "status.cancelled", false, true)]), [SLACK]);
  await expectTold("pickup: watch completed", "pickup", event("subscription.completed", [], { metadata: {} }), []);
  await expectTold("pickup: a later change texts nobody", "pickup", pickupEvent([change("flight.arrived", "status.phase", "landed", "arrived")]), []);
}

const onExit = () => {
  cleanUp();
  process.exit(130);
};
process.on("SIGINT", onExit);

try {
  await main();
} catch (error) {
  failures += 1;
  console.error(`\n${error.stack ?? error}`);
} finally {
  if (failures > 0) {
    try {
      console.error(`\nLast lines of the n8n log:\n${docker("logs", "--tail", "30", tag)}`);
    } catch {
      /* no container */
    }
  }
  cleanUp();
}
console.log(failures === 0 ? "\nAll checks passed." : `\n${failures} check(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
