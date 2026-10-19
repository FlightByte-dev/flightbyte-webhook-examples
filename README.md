# FlightByte webhook examples

Receivers for [FlightByte](https://flightbyte.dev) webhooks in Node.js, Python and Go, plus a script that sends signed test events so you can exercise a receiver before you have an API key.

Each receiver does the four things a webhook endpoint has to get right:

1. **Verifies the signature** against the raw request body, with a five-minute replay window.
2. **Deduplicates on the event id.** Retries carry the same id and body.
3. **Answers `204` first**, then does the work. FlightByte waits ten seconds before it retries.
4. **Branches on the event type**, including the `subscription.*` lifecycle events.

No dependencies beyond each language's standard library.

## Run one

```bash
export FLIGHTBYTE_WEBHOOK_SECRET=whsec_...   # returned when you create a subscription

node node/receiver.mjs            # Node.js 20+
python3 python/receiver.py        # Python 3.11+
go run ./go                       # Go 1.22+
```

All three listen on port `4599` (override with `PORT`) and accept `POST` on any path.

## Send a test event

```bash
FLIGHTBYTE_WEBHOOK_SECRET=whsec_... node scripts/send-test-event.mjs http://localhost:4599/hooks/flights
```

The script signs `fixtures/flight.updated.json` exactly the way FlightByte does and posts it with the same headers. A few flags show the receiver doing its job:

| Flag | What happens | Expected answer |
| --- | --- | --- |
| *(none)* | A fresh event id each run | `204` |
| `--attempt 2` | Keeps the fixture's id, so a second send is a duplicate | `204`, handled once |
| `--tamper` | Changes a byte after signing | `401` |
| `--stale` | Signs with a timestamp ten minutes old | `401` |

Run it with the wrong secret and you get `401` as well.

## Point a real subscription at it

Expose the port with a tunnel, then create a subscription with that URL:

```bash
cloudflared tunnel --url http://localhost:4599   # or: ngrok http 4599

curl https://api.flightbyte.dev/v1/subscriptions \
  -H "x-api-key: $FLIGHTBYTE_KEY" \
  -H "content-type: application/json" \
  -d '{
    "carrier": "TK", "flightNumber": "1848", "date": "2026-09-12",
    "webhookUrl": "https://<your-tunnel>/hooks/flights",
    "metadata": { "bookingId": "BK-1042" }
  }'
```

The response includes the `secret` to put in `FLIGHTBYTE_WEBHOOK_SECRET`. `POST /v1/subscriptions/{id}/test` sends a `subscription.test` event on demand.

With the [FlightByte MCP server](https://flightbyte.dev/docs/mcp) connected, an assistant can do this for you: ask Claude, Cursor or VS Code to watch a flight and send its changes to your tunnel URL, then to send a test event and show you the delivery log. In Claude, add FlightByte from the [connector directory](https://claude.ai/directory/flightbyte).

## How the signature works

```
x-flightbyte-signature: t=1789305971,v1=5f1c9a...e3b2
v1 = HMAC-SHA256(secret, "<t>." + <raw body bytes>)
```

Verify against the bytes you received, before any JSON parsing. Reject when `|now - t|` is more than a few minutes. The same six headers are also sent under the legacy `x-flightradar-*` names; new code should read `x-flightbyte-*`.

Full details: [Webhooks](https://flightbyte.dev/docs/webhooks) in the FlightByte docs.

## Fixture

`fixtures/flight.updated.json` is a real-shaped `flight.updated` event with the snapshot trimmed to the fields these receivers read. The complete snapshot is documented under [Flights](https://flightbyte.dev/docs/flights#the-snapshot).

## License

MIT.
