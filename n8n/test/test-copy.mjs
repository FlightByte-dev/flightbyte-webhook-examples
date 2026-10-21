/**
 * Turns a template into a copy the test can run without Slack, SendGrid,
 * Twilio or a FlightByte key:
 * - each Slack, SendGrid and Twilio node becomes an HTTP call to the stub,
 *   carrying the fields the real node would send, so the test sees who would
 *   have been told what;
 * - "Watch the flight" calls the stub's /v1/subscriptions instead of the API;
 * - the Crypto and Custom Auth nodes point at the test credentials.
 */
export const CREDENTIALS = {
  crypto: { id: "fbTestCrypto001", name: "FlightByte webhook secret (test)" },
  httpCustomAuth: { id: "fbTestApi000001", name: "FlightByte API (test)" },
};

const fieldsOf = (node) => {
  const p = node.parameters;
  switch (node.type) {
    case "n8n-nodes-base.slack":
      return { text: p.text };
    case "n8n-nodes-base.sendGrid":
      return { to: p.toEmail, subject: p.subject, text: p.contentValue };
    case "n8n-nodes-base.twilio":
      return { to: p.to, message: p.message, whatsapp: String(p.toWhatsapp ?? false) };
  }
};

// "={{ expr }}" becomes (expr); text with expressions inside becomes a template literal.
const js = (value) => {
  if (!value.startsWith("=")) return JSON.stringify(value);
  const whole = value.slice(1).match(/^\{\{([\s\S]*)\}\}$/);
  if (whole && !whole[1].includes("{{")) return `(${whole[1].trim()})`;
  return `\`${value.slice(1).replace(/`/g, "\\`").replace(/\{\{([\s\S]*?)\}\}/g, (_, e) => `\${${e.trim()}}`)}\``;
};

export function testCopy(workflow, { id, stub }) {
  const copy = structuredClone(workflow);
  copy.id = id;
  copy.name = `${workflow.name} [test]`;
  copy.active = false;
  copy.nodes = copy.nodes.map((node) => {
    const fields = fieldsOf(node);
    if (fields) {
      const pairs = Object.entries({ node: node.name, ...fields }).map(([key, value]) => `${JSON.stringify(key)}: ${js(value)}`);
      return {
        ...node,
        type: "n8n-nodes-base.httpRequest",
        typeVersion: 4.2,
        parameters: {
          method: "POST",
          url: `${stub}/capture`,
          sendBody: true,
          specifyBody: "json",
          jsonBody: `={{ JSON.stringify({ ${pairs.join(", ")} }) }}`,
          options: {},
        },
      };
    }
    if (node.type === "n8n-nodes-base.crypto") return { ...node, credentials: { crypto: CREDENTIALS.crypto } };
    if (node.name === "Watch the flight") {
      return {
        ...node,
        parameters: { ...node.parameters, url: `${stub}/v1/subscriptions` },
        credentials: { httpCustomAuth: CREDENTIALS.httpCustomAuth },
      };
    }
    return node;
  });
  return copy;
}
