#!/usr/bin/env node
/**
 * Builds the n8n workflow templates into n8n/workflows/. flightbyte.dev serves
 * copies of them (landing's `npm run sync:n8n`) and the n8n guide links there.
 * The Code node sources live in n8n/code/ so they can be read and reviewed as
 * JavaScript.
 *
 *   node n8n/build.mjs
 *
 * Node versions are pinned to ones n8n 2.x ships; n8n/test/run.mjs checks the
 * built workflows on a real n8n. Credentials are left out: n8n asks for them
 * when the workflow is opened. Contact details stay in an n8n data table;
 * FlightByte only ever sees the flight and, for alerts, the booking reference.
 */
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const out = resolve(here, "workflows");
const GUIDE = "https://flightbyte.dev/guides/flight-change-alerts-n8n";
const FREE_KEY = "https://flightbyte.dev/get-api-key?plan=free";

/** A link out of a template, tagged so sign-ups that start in n8n show up as such. */
const tracked = (url, campaign) => {
  const [base, hash] = url.split("#");
  const tags = `utm_source=n8n&utm_medium=template&utm_campaign=${campaign}`;
  return `${base}${base.includes("?") ? "&" : "?"}${tags}${hash ? `#${hash}` : ""}`;
};
const API = "https://api.flightbyte.dev/v1/subscriptions";

/** Stable ids, so a rebuild only changes what actually changed. */
const uid = (...seed) => {
  const hex = createHash("sha1").update(seed.join("/")).digest("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
};

function workflow(name, slug) {
  const nodes = [];
  const connections = {};
  const add = (node) => {
    nodes.push({ id: uid(slug, node.name), ...node });
    return node.name;
  };
  const link = (from, to, output = 0) => {
    const outputs = (connections[from] ??= { main: [] }).main;
    while (outputs.length <= output) outputs.push([]);
    outputs[output].push({ node: to, type: "main", index: 0 });
  };
  const note = (name, [x, y], [width, height], content, color) =>
    add({
      name,
      type: "n8n-nodes-base.stickyNote",
      typeVersion: 1,
      position: [x, y],
      parameters: { content, width, height, ...(color ? { color } : {}) },
    });
  const json = () => ({
    name,
    nodes,
    connections,
    pinData: {},
    settings: { executionOrder: "v1" },
    meta: { templateCredsSetupCompleted: false },
    tags: [],
  });
  return { add, link, note, json, slug };
}

/** One condition in the shape If, Filter and Switch (v2 conditions) share. */
const condition = (wf, key, leftValue, operator, rightValue) => ({
  id: uid(wf.slug, "condition", key),
  leftValue,
  ...(rightValue === undefined ? {} : { rightValue }),
  operator,
});
const conditions = (list, combinator = "and") => ({
  options: { caseSensitive: true, leftValue: "", typeValidation: "strict", version: 2 },
  conditions: list,
  combinator,
});
const isTrue = { type: "boolean", operation: "true", singleValue: true };
const equals = { type: "string", operation: "equals" };

const assignment = (wf, name, type, value) => ({ id: uid(wf.slug, "set", name), name, type, value });

// ── Data table: who to tell, kept in n8n ──────────────────────────────────

const tableRef = (table) => ({ __rl: true, mode: "name", value: table });
const bySubscription = (keyValue) => ({
  matchType: "allConditions",
  filters: { conditions: [{ keyName: "subscriptionId", condition: "eq", keyValue }] },
});

function ensureTable(wf, name, table, columns, position) {
  return wf.add({
    name,
    type: "n8n-nodes-base.dataTable",
    typeVersion: 1,
    position,
    parameters: {
      resource: "table",
      operation: "create",
      tableName: table,
      columns: { column: ["subscriptionId", ...columns].map((column) => ({ name: column, type: "string" })) },
      options: { createIfNotExists: true },
    },
  });
}

function saveRow(wf, name, table, value, position) {
  return wf.add({
    name,
    type: "n8n-nodes-base.dataTable",
    typeVersion: 1,
    position,
    parameters: {
      operation: "insert",
      dataTableId: tableRef(table),
      columns: {
        mappingMode: "defineBelow",
        value,
        matchingColumns: [],
        schema: Object.keys(value).map((id) => ({
          id,
          displayName: id,
          required: false,
          defaultMatch: false,
          display: true,
          type: "string",
          canBeUsedToMatch: true,
        })),
        attemptToConvertTypes: false,
        convertFieldsToString: false,
      },
      options: {},
    },
  });
}

function lookUpRow(wf, name, table, position, settings = {}) {
  return wf.add({
    name,
    type: "n8n-nodes-base.dataTable",
    typeVersion: 1,
    position,
    ...settings,
    parameters: {
      operation: "get",
      dataTableId: tableRef(table),
      ...bySubscription("={{ $json.body.subscriptionId }}"),
      limit: 1,
    },
  });
}

function forgetRow(wf, name, table, position) {
  return wf.add({
    name,
    type: "n8n-nodes-base.dataTable",
    typeVersion: 1,
    position,
    parameters: {
      operation: "deleteRows",
      dataTableId: tableRef(table),
      ...bySubscription("={{ $json.body.subscriptionId }}"),
      options: {},
    },
  });
}

// ── Form → subscription ───────────────────────────────────────────────────

/**
 * Form → data table ready → subscription request → save who to tell → done page.
 * `contact` maps table columns to form fields; `metadata` and `extra` add to the request body.
 */
function watchFlight(wf, { form, webhookPath, table, contact, metadata, extra = "" }, [x, y]) {
  const ready = ensureTable(wf, "Make sure the table exists", table, Object.keys(contact), [x, y]);
  wf.link(form, ready);

  const answers = `$('${form}').item.json`;
  const build = wf.add({
    name: "Build the request",
    type: "n8n-nodes-base.set",
    typeVersion: 3.4,
    position: [x + 220, y],
    parameters: {
      assignments: {
        assignments: [
          // The production URL of this workflow's own FlightByte webhook (n8n's WEBHOOK_URL, when set).
          assignment(
            wf,
            "webhookUrl",
            "string",
            `={{ $execution.resumeUrl.split('/webhook-waiting/')[0] }}/webhook/${webhookPath}`,
          ),
          assignment(wf, "carrier", "string", `={{ ${answers}["Flight number"].replace(/\\s+/g, '').toUpperCase().slice(0, 2) }}`),
          assignment(wf, "flightNumber", "string", `={{ ${answers}["Flight number"].replace(/\\s+/g, '').toUpperCase().slice(2) }}`),
          assignment(wf, "date", "string", `={{ ${answers}["Departure date"] }}`),
          assignment(wf, "origin", "string", `={{ (${answers}["Departure airport"] ?? '').trim().toUpperCase() }}`),
          ...(metadata ? [assignment(wf, "metadata", "object", `={{ ${metadata.replace(/\$answers/g, () => answers)} }}`)] : []),
          ...Object.entries(contact).map(([column, field]) => assignment(wf, column, "string", `={{ ${answers}[${JSON.stringify(field)}] ?? '' }}`)),
        ],
      },
      options: {},
    },
  });
  wf.link(ready, build);

  const request = wf.add({
    name: "Watch the flight",
    type: "n8n-nodes-base.httpRequest",
    typeVersion: 4.2,
    position: [x + 440, y],
    parameters: {
      method: "POST",
      url: API,
      authentication: "genericCredentialType",
      genericAuthType: "httpCustomAuth",
      sendBody: true,
      specifyBody: "json",
      jsonBody:
        "={{ JSON.stringify({ carrier: $json.carrier, flightNumber: $json.flightNumber, date: $json.date, " +
        "...($json.origin ? { origin: $json.origin } : {}), webhookUrl: $json.webhookUrl" +
        `${metadata ? ", metadata: $json.metadata" : ""}${extra} }) }}`,
      options: { response: { response: { fullResponse: true, neverError: true } } },
    },
  });
  wf.link(build, request);

  const ok = wf.add({
    name: "Watching?",
    type: "n8n-nodes-base.if",
    typeVersion: 2.2,
    position: [x + 660, y],
    parameters: {
      conditions: conditions([
        condition(wf, "created", "={{ $json.statusCode }}", { type: "number", operation: "lt" }, 300),
      ]),
      options: {},
    },
  });
  wf.link(request, ok);

  const save = saveRow(
    wf,
    "Remember who to tell",
    table,
    {
      subscriptionId: "={{ $json.body.id }}",
      ...Object.fromEntries(Object.keys(contact).map((column) => [column, `={{ $('Build the request').item.json.${column} }}`])),
    },
    [x + 880, y - 90],
  );
  wf.link(ok, save, 0);

  const done = wf.add({
    name: "Show the watch",
    type: "n8n-nodes-base.form",
    typeVersion: 1,
    position: [x + 1100, y - 90],
    webhookId: uid(wf.slug, "done"),
    parameters: {
      operation: "completion",
      completionTitle:
        "=Watching {{ $('Watch the flight').item.json.body.carrier }}{{ $('Watch the flight').item.json.body.flightNumber }} on {{ $('Watch the flight').item.json.body.date }}",
      completionMessage:
        "={{ $('Watch the flight').item.json.body.status === 'pending' ? \"The airline has not published this flight yet. FlightByte starts watching it as soon as it appears.\" : \"Changes to this flight will reach this workflow as they happen.\" }}\n\nSubscription {{ $('Watch the flight').item.json.body.id }}",
    },
  });
  wf.link(save, done);

  const failed = wf.add({
    name: "Show the error",
    type: "n8n-nodes-base.form",
    typeVersion: 1,
    position: [x + 880, y + 90],
    webhookId: uid(wf.slug, "failed"),
    parameters: {
      operation: "completion",
      completionTitle: "Could not watch this flight",
      completionMessage: "={{ [].concat($json.body.message ?? `FlightByte answered ${$json.statusCode}`).join(' ') }}",
    },
  });
  wf.link(ok, failed, 1);
}

// ── Webhook → verified event ──────────────────────────────────────────────

/** Webhook → signature check → 204 or 401 → drop retries already handled. Returns the last node. */
function receiver(wf, path, [x, y]) {
  const hook = wf.add({
    name: "FlightByte webhook",
    type: "n8n-nodes-base.webhook",
    typeVersion: 2,
    position: [x, y],
    webhookId: uid(wf.slug, "webhook"),
    parameters: { httpMethod: "POST", path, responseMode: "responseNode", options: { rawBody: true } },
  });
  const text = wf.add({
    name: "Raw body as text",
    type: "n8n-nodes-base.extractFromFile",
    typeVersion: 1,
    position: [x + 220, y],
    parameters: { operation: "text", destinationKey: "rawBody", options: { keepSource: "json" } },
  });
  const sign = wf.add({
    name: "Sign the raw body",
    type: "n8n-nodes-base.crypto",
    typeVersion: 2,
    position: [x + 440, y],
    parameters: {
      action: "hmac",
      type: "SHA256",
      value: "={{ $json.headers['x-flightbyte-timestamp'] }}.{{ $json.rawBody }}",
      dataPropertyName: "expectedSignature",
      encoding: "hex",
    },
  });
  const valid = wf.add({
    name: "Signature valid?",
    type: "n8n-nodes-base.if",
    typeVersion: 2.2,
    position: [x + 660, y],
    parameters: {
      conditions: conditions([
        condition(
          wf,
          "signature",
          "={{ $json.expectedSignature }}",
          equals,
          "={{ String($json.headers['x-flightbyte-signature'] ?? '').split('v1=')[1] ?? '' }}",
        ),
        condition(
          wf,
          "fresh",
          "={{ Math.abs($now.toSeconds() - Number($json.headers['x-flightbyte-timestamp'])) }}",
          { type: "number", operation: "lt" },
          300,
        ),
      ]),
      options: {},
    },
  });
  const accept = wf.add({
    name: "Accept (204)",
    type: "n8n-nodes-base.respondToWebhook",
    typeVersion: 1.1,
    position: [x + 880, y - 90],
    parameters: { respondWith: "noData", options: { responseCode: 204 } },
  });
  const reject = wf.add({
    name: "Reject (401)",
    type: "n8n-nodes-base.respondToWebhook",
    typeVersion: 1.1,
    position: [x + 880, y + 90],
    parameters: { respondWith: "noData", options: { responseCode: 401 } },
  });
  const dedupe = wf.add({
    name: "Skip retries already handled",
    type: "n8n-nodes-base.removeDuplicates",
    typeVersion: 2,
    position: [x + 1100, y - 90],
    parameters: { operation: "removeItemsSeenInPreviousExecutions", dedupeValue: "={{ $json.body.id }}", options: {} },
  });
  wf.link(hook, text);
  wf.link(text, sign);
  wf.link(sign, valid);
  wf.link(valid, accept, 0);
  wf.link(valid, reject, 1);
  wf.link(accept, dedupe);
  return dedupe;
}

/** Switch on the event type; `routes` is [output name, event type][]. */
function eventType(wf, routes, position) {
  return wf.add({
    name: "Event type",
    type: "n8n-nodes-base.switch",
    typeVersion: 3.2,
    position,
    parameters: {
      rules: {
        values: routes.map(([outputKey, type]) => ({
          conditions: conditions([condition(wf, type, "={{ $json.body.type }}", equals, type)]),
          renameOutput: true,
          outputKey,
        })),
      },
      options: {},
    },
  });
}

const formField = (fieldLabel, extra = {}) => ({ fieldLabel, ...extra });
const flightFields = [
  formField("Flight number", { placeholder: "TK1848", requiredField: true }),
  formField("Departure date", { fieldType: "date", requiredField: true }),
  formField("Departure airport", { placeholder: "IST (only if the flight number flies several legs that day)" }),
];

const SETUP_CREDENTIALS = `**1. FlightByte API.** In *Watch the flight*, create a **Custom Auth** credential. It adds your key to the request and gives every watched flight the same signing secret:
\`\`\`json
{
  "headers": { "x-api-key": "fb_live_…" },
  "body": { "secret": "whsec_…" }
}
\`\`\`
Make the secret up, for example \`whsec_\` followed by \`openssl rand -hex 24\`.

**2. Webhook secret.** In *Sign the raw body*, create a **Crypto** credential and paste the same \`whsec_…\` as its *Hmac Secret*.`;

const VERIFY_NOTE = `## Verify, then answer
Checks FlightByte's HMAC signature on the raw body, refuses anything older than five minutes, answers \`204\` and skips retries.`;

// ── Flight change alerts ──────────────────────────────────────────────────

function alerts() {
  const wf = workflow("Send flight change alerts to Slack, email and SMS with FlightByte", "alerts");
  const table = "flightbyte_passengers";

  wf.note(
    "About this workflow",
    [-660, -260],
    [560, 1240],
    `## Send flight change alerts to Slack, email and SMS

For travel agencies, transfer companies and corporate travel teams. FlightByte watches each flight and calls this workflow only when something changes, with a list of exactly what changed. Nothing runs on a schedule.

### How it works
1. The form adds a flight. FlightByte starts watching it, and the passenger's contact details go to the n8n data table \`${table}\`. FlightByte only sees the flight and the booking reference.
2. Each change arrives as a signed webhook. The workflow checks the signature, answers \`204\` and skips retries.
3. Every change goes to Slack. Gate, time, delay, cancellation and diversion go to the passenger by email. Cancellations, diversions and arrival delays of an hour or more also go by SMS.
4. When the flight is over, its row is deleted.

### Setup
${SETUP_CREDENTIALS}

**3. Senders.** Pick your Slack channel in the three Slack nodes, and set the sender in *Email the passenger* and *Text the passenger*.

**4. Go.** Publish, open the form's production URL and add a flight. \`POST /v1/subscriptions/{id}/test\` sends a test event to Slack.

### Customization tips
- Change who hears what in the list at the top of *Write the messages*.
- Swap the form for Google Sheets, Airtable or your booking system, and map its columns in *Build the request*.

[Step-by-step guide](${tracked(GUIDE, "flight-change-alerts")}) · [Free API key](${tracked(FREE_KEY, "flight-change-alerts")})`,
  );

  wf.note(
    "Watch a flight",
    [-60, -260],
    [1540, 460],
    `## 1. Watch a flight\nThe answers become a FlightByte subscription and a row in \`${table}\`.`,
    7,
  );
  const form = wf.add({
    name: "Booking form",
    type: "n8n-nodes-base.formTrigger",
    typeVersion: 2.2,
    position: [0, -40],
    webhookId: uid("alerts", "form"),
    parameters: {
      formTitle: "Watch a flight",
      formDescription: "The passenger hears about gate changes, delays and cancellations as they happen.",
      formFields: {
        values: [
          ...flightFields,
          formField("Passenger name"),
          formField("Email", { fieldType: "email" }),
          formField("Mobile phone", { placeholder: "+905321234567" }),
          formField("Booking reference"),
        ],
      },
      options: { path: "watch-a-flight", buttonLabel: "Watch this flight" },
    },
  });
  watchFlight(
    wf,
    {
      form,
      webhookPath: "flightbyte-alerts",
      table,
      contact: { passengerName: "Passenger name", email: "Email", phone: "Mobile phone", bookingRef: "Booking reference" },
      metadata: '$answers["Booking reference"] ? { bookingRef: $answers["Booking reference"] } : {}',
    },
    [220, -40],
  );

  wf.note("Verify", [-60, 220], [1340, 440], VERIFY_NOTE, 7);
  const last = receiver(wf, "flightbyte-alerts", [0, 420]);

  wf.note(
    "Route",
    [1300, 220],
    [1120, 800],
    "## 2. Who hears what\nEdit the list at the top of *Write the messages*. Finished flights leave the table.",
    7,
  );
  const route = eventType(
    wf,
    [
      ["Flight changed", "flight.updated"],
      ["Test event", "subscription.test"],
      ["Watch suspended", "subscription.suspended"],
      ["Watch completed", "subscription.completed"],
    ],
    [1340, 330],
  );
  wf.link(last, route);

  // Always output, so Slack still hears about flights watched some other way.
  const lookUp = lookUpRow(wf, "Look up the passenger", table, [1560, 330], { alwaysOutputData: true });
  wf.link(route, lookUp, 0);

  const messages = wf.add({
    name: "Write the messages",
    type: "n8n-nodes-base.code",
    typeVersion: 2,
    position: [1780, 330],
    parameters: { mode: "runOnceForEachItem", jsCode: sources.alerts },
  });
  wf.link(lookUp, messages);

  const slack = (name, position, text) =>
    wf.add({
      name,
      type: "n8n-nodes-base.slack",
      typeVersion: 2.3,
      position,
      parameters: {
        select: "channel",
        channelId: { __rl: true, mode: "list", value: "" },
        text,
        otherOptions: { includeLinkToWorkflow: false },
      },
    });

  wf.link(messages, slack("Post to Slack", [2000, 240], "={{ $json.slackText }}"));

  const emailIf = wf.add({
    name: "Email the passenger?",
    type: "n8n-nodes-base.if",
    typeVersion: 2.2,
    position: [2000, 420],
    parameters: { conditions: conditions([condition(wf, "email", "={{ $json.sendEmail }}", isTrue)]), options: {} },
  });
  wf.link(messages, emailIf);
  wf.link(
    emailIf,
    wf.add({
      name: "Email the passenger",
      type: "n8n-nodes-base.sendGrid",
      typeVersion: 1,
      position: [2220, 420],
      parameters: {
        resource: "mail",
        fromEmail: "flights@example.com",
        fromName: "Flight updates",
        toEmail: "={{ $json.emailTo }}",
        subject: "={{ $json.emailSubject }}",
        contentValue: "={{ $json.emailText }}",
        additionalFields: {},
      },
    }),
  );

  const smsIf = wf.add({
    name: "Text the passenger?",
    type: "n8n-nodes-base.if",
    typeVersion: 2.2,
    position: [2000, 600],
    parameters: { conditions: conditions([condition(wf, "sms", "={{ $json.sendSms }}", isTrue)]), options: {} },
  });
  wf.link(messages, smsIf);
  wf.link(
    smsIf,
    wf.add({
      name: "Text the passenger",
      type: "n8n-nodes-base.twilio",
      typeVersion: 1,
      position: [2220, 600],
      parameters: { from: "+15550000000", to: "={{ $json.smsTo }}", message: "={{ $json.smsText }}", options: {} },
    }),
  );

  wf.link(
    route,
    slack(
      "Confirm the test event",
      [1560, 540],
      "=FlightByte test event received for {{ $json.body.subscriptionId }}. Webhooks reach this workflow and the signature checks out.",
    ),
    1,
  );
  wf.link(
    route,
    slack(
      "Warn about the suspended watch",
      [1560, 700],
      "=FlightByte suspended {{ $json.body.subscriptionId }} after repeated failed deliveries. Fix this workflow, then resume the subscription with POST /v1/subscriptions/{{ $json.body.subscriptionId }}/resume.",
    ),
    2,
  );
  wf.link(route, forgetRow(wf, "Forget the passenger", table, [1560, 860]), 3);

  return wf.json();
}

// ── Airport pickup ────────────────────────────────────────────────────────

const DRIVER_EVENTS = [
  "flight.departed",
  "flight.arrived",
  "flight.cancelled",
  "flight.diverted",
  "arrival.estimated.changed",
  "arrival.terminal.changed",
  "arrival.baggage.changed",
];

function pickup() {
  const wf = workflow("Text airport pickup drivers when flights depart, land or change, with FlightByte", "pickup");
  const table = "flightbyte_pickups";

  wf.note(
    "About this workflow",
    [-660, -260],
    [560, 1180],
    `## Text airport pickup drivers when flights depart, land or change

For transfer and chauffeur companies whose drivers wait at arrivals. FlightByte watches the passenger's flight and calls this workflow only when something matters to the driver.

### How it works
1. The form books a pickup. FlightByte watches the flight for arrival changes only, and the driver's phone goes to the n8n data table \`${table}\`.
2. Each change arrives as a signed webhook. The workflow checks the signature, answers \`204\` and skips retries.
3. The driver gets one SMS or WhatsApp when the flight leaves, when the landing time moves by ten minutes or more, when it reaches the gate, when the bags have a belt, or when it is cancelled or diverted.
4. When the flight is over, its row is deleted.

### Setup
${SETUP_CREDENTIALS}

**3. Sender.** Set your Twilio number in *Text the driver*. Turn on *To WhatsApp* to send WhatsApp messages instead.

**4. Go.** Publish, open the form's production URL and book a pickup.

### Customization tips
- Change \`MIN_SHIFT_MINUTES\` at the top of *Write the driver's text* to text the driver more or less often.
- To take bookings from your own system, swap the form and map its columns in *Build the request*.

[Step-by-step guide](${tracked(`${GUIDE}#airport-pickup`, "airport-pickup")}) · [Free API key](${tracked(FREE_KEY, "airport-pickup")})`,
  );

  wf.note(
    "Book",
    [-60, -260],
    [1540, 460],
    `## 1. Book a pickup\nThe date is the departure date, local to the departure airport. The driver's phone goes to \`${table}\`.`,
    7,
  );
  const form = wf.add({
    name: "Pickup form",
    type: "n8n-nodes-base.formTrigger",
    typeVersion: 2.2,
    position: [0, -40],
    webhookId: uid("pickup", "form"),
    parameters: {
      formTitle: "Book an airport pickup",
      formDescription: "The driver gets a text when the flight leaves, when the landing time moves and when it reaches the gate.",
      formFields: {
        values: [
          ...flightFields,
          formField("Passenger name"),
          formField("Driver's mobile phone", { placeholder: "+905321234567", requiredField: true }),
        ],
      },
      options: { path: "book-a-pickup", buttonLabel: "Book the pickup" },
    },
  });
  watchFlight(
    wf,
    {
      form,
      webhookPath: "flightbyte-pickup",
      table,
      contact: { passengerName: "Passenger name", driverPhone: "Driver's mobile phone" },
      extra: `, events: ${JSON.stringify(DRIVER_EVENTS).replace(/"/g, "'")}`,
    },
    [220, -40],
  );

  wf.note("Verify", [-60, 220], [1340, 440], VERIFY_NOTE, 7);
  const last = receiver(wf, "flightbyte-pickup", [0, 420]);

  wf.note(
    "Text",
    [1300, 220],
    [920, 480],
    "## 2. Text the driver\nArrival-time moves under ten minutes are skipped. Finished flights leave the table.",
    7,
  );
  const route = eventType(
    wf,
    [
      ["Flight changed", "flight.updated"],
      ["Watch completed", "subscription.completed"],
    ],
    [1340, 330],
  );
  wf.link(last, route);

  const lookUp = lookUpRow(wf, "Look up the pickup", table, [1560, 330]);
  wf.link(route, lookUp, 0);
  const write = wf.add({
    name: "Write the driver's text",
    type: "n8n-nodes-base.code",
    typeVersion: 2,
    position: [1780, 330],
    parameters: { jsCode: sources.driver },
  });
  wf.link(lookUp, write);
  wf.link(
    write,
    wf.add({
      name: "Text the driver",
      type: "n8n-nodes-base.twilio",
      typeVersion: 1,
      position: [2000, 330],
      parameters: { from: "+15550000000", to: "={{ $json.to }}", toWhatsapp: false, message: "={{ $json.text }}", options: {} },
    }),
  );
  wf.link(route, forgetRow(wf, "Forget the pickup", table, [1560, 540]), 1);

  return wf.json();
}

const sources = {
  alerts: await readFile(resolve(here, "code/alert-messages.js"), "utf8"),
  driver: await readFile(resolve(here, "code/driver-text.js"), "utf8"),
};

await mkdir(out, { recursive: true });
for (const [file, build] of [
  ["flight-change-alerts.json", alerts],
  ["airport-pickup.json", pickup],
]) {
  await writeFile(resolve(out, file), `${JSON.stringify(build(), null, 2)}\n`);
  console.log(`wrote n8n/workflows/${file}`);
}
