"""
A FlightByte webhook receiver on the standard library.

    FLIGHTBYTE_WEBHOOK_SECRET=whsec_... python3 python/receiver.py

Verifies the signature against the raw body, deduplicates on the event id,
answers 204 at once, and only then does the work.
"""
import hashlib
import hmac
import json
import os
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

SECRET = os.environ.get("FLIGHTBYTE_WEBHOOK_SECRET", "").encode()
PORT = int(os.environ.get("PORT", "4599"))
TOLERANCE_SECONDS = 300

# Line-buffer stdout so logs show up promptly under a supervisor or in a container.
sys.stdout.reconfigure(line_buffering=True)

if not SECRET:
    sys.exit("set FLIGHTBYTE_WEBHOOK_SECRET to the secret returned when the subscription was created")


def verify(header: str | None, raw_body: bytes, secret: bytes = SECRET, tolerance: int = TOLERANCE_SECONDS) -> bool:
    """`t=<unix seconds>,v1=<hex>` where v1 = HMAC-SHA256(secret, f"{t}.{raw_body}")."""
    if not header:
        return False
    parts = dict(p.split("=", 1) for p in header.split(",") if "=" in p)
    t, v1 = parts.get("t"), parts.get("v1")
    if not t or not v1:
        return False
    try:
        if abs(time.time() - float(t)) > tolerance:
            return False
    except ValueError:
        return False
    expected = hmac.new(secret, f"{t}.".encode() + raw_body, hashlib.sha256).hexdigest()
    return hmac.compare_digest(v1, expected)


# In production this is a table keyed by event id; a set is enough to show the shape.
seen: set[str] = set()
seen_lock = threading.Lock()


def handle(event: dict) -> None:
    kind = event["type"]
    if kind == "flight.updated":
        for change in event["changes"]:
            print(f"  {change['type']}: {change['message']}")
    elif kind in ("subscription.created", "subscription.activated"):
        print(f"  watching {event.get('flightKey') or '(flight not resolved yet)'}")
    elif kind == "subscription.completed":
        print("  watch ended; archive the booking")
    elif kind == "subscription.suspended":
        print("  deliveries kept failing; fix the endpoint and POST /v1/subscriptions/{id}/resume")
    elif kind == "subscription.test":
        print("  test event received")


class Receiver(BaseHTTPRequestHandler):
    def log_message(self, *_: object) -> None:  # quieter than the default access log
        pass

    def do_POST(self) -> None:
        raw_body = self.rfile.read(int(self.headers.get("content-length", "0")))
        if not verify(self.headers.get("x-flightbyte-signature"), raw_body):
            print("rejected: bad signature")
            self.send_response(401)
            self.end_headers()
            return

        event = json.loads(raw_body)
        with seen_lock:
            duplicate = event["id"] in seen
            seen.add(event["id"])

        # Acknowledge first; FlightByte waits ten seconds and then retries.
        self.send_response(204)
        self.end_headers()
        if duplicate:
            return

        attempt = self.headers.get("x-flightbyte-delivery-attempt")
        booking = (event.get("metadata") or {}).get("bookingId", "-")
        print(f"[{event['type']}] {event.get('flightKey', '')} attempt {attempt} booking {booking}")
        threading.Thread(target=handle, args=(event,), daemon=True).start()


if __name__ == "__main__":
    print(f"receiving FlightByte webhooks on http://localhost:{PORT}")
    ThreadingHTTPServer(("", PORT), Receiver).serve_forever()
