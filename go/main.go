// A FlightByte webhook receiver on the standard library.
//
//	FLIGHTBYTE_WEBHOOK_SECRET=whsec_... go run ./go
//
// Verifies the signature against the raw body, deduplicates on the event id,
// answers 204 at once, and only then does the work.
package main

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"strconv"
	"strings"
	"sync"
	"time"
)

const tolerance = 5 * time.Minute

// Verify checks `t=<unix seconds>,v1=<hex>` where v1 = HMAC-SHA256(secret, t + "." + rawBody).
func Verify(secret, header string, rawBody []byte, tolerance time.Duration) bool {
	var t, v1 string
	for _, part := range strings.Split(header, ",") {
		if k, v, ok := strings.Cut(part, "="); ok {
			switch k {
			case "t":
				t = v
			case "v1":
				v1 = v
			}
		}
	}
	ts, err := strconv.ParseInt(t, 10, 64)
	if err != nil || time.Since(time.Unix(ts, 0)).Abs() > tolerance {
		return false
	}
	mac := hmac.New(sha256.New, []byte(secret))
	mac.Write([]byte(t + "."))
	mac.Write(rawBody)
	expected := hex.EncodeToString(mac.Sum(nil))
	return hmac.Equal([]byte(v1), []byte(expected))
}

type change struct {
	Type    string `json:"type"`
	Message string `json:"message"`
}

type event struct {
	ID        string            `json:"id"`
	Type      string            `json:"type"`
	FlightKey string            `json:"flightKey"`
	Changes   []change          `json:"changes"`
	Metadata  map[string]string `json:"metadata"`
}

// In production this is a table keyed by event id; a map is enough to show the shape.
var (
	seen   = map[string]struct{}{}
	seenMu sync.Mutex
)

func handle(e event) {
	switch e.Type {
	case "flight.updated":
		for _, c := range e.Changes {
			fmt.Printf("  %s: %s\n", c.Type, c.Message)
		}
	case "subscription.created", "subscription.activated":
		key := e.FlightKey
		if key == "" {
			key = "(flight not resolved yet)"
		}
		fmt.Printf("  watching %s\n", key)
	case "subscription.completed":
		fmt.Println("  watch ended; archive the booking")
	case "subscription.suspended":
		fmt.Println("  deliveries kept failing; fix the endpoint and POST /v1/subscriptions/{id}/resume")
	case "subscription.test":
		fmt.Println("  test event received")
	}
}

func main() {
	secret := os.Getenv("FLIGHTBYTE_WEBHOOK_SECRET")
	if secret == "" {
		log.Fatal("set FLIGHTBYTE_WEBHOOK_SECRET to the secret returned when the subscription was created")
	}
	port := os.Getenv("PORT")
	if port == "" {
		port = "4599"
	}

	http.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			w.WriteHeader(http.StatusMethodNotAllowed)
			return
		}
		rawBody, err := io.ReadAll(r.Body)
		if err != nil {
			w.WriteHeader(http.StatusBadRequest)
			return
		}
		if !Verify(secret, r.Header.Get("x-flightbyte-signature"), rawBody, tolerance) {
			log.Println("rejected: bad signature")
			w.WriteHeader(http.StatusUnauthorized)
			return
		}

		var e event
		if err := json.Unmarshal(rawBody, &e); err != nil {
			w.WriteHeader(http.StatusBadRequest)
			return
		}

		seenMu.Lock()
		_, duplicate := seen[e.ID]
		seen[e.ID] = struct{}{}
		seenMu.Unlock()

		// Acknowledge first; FlightByte waits ten seconds and then retries.
		w.WriteHeader(http.StatusNoContent)
		if duplicate {
			return
		}

		booking := e.Metadata["bookingId"]
		if booking == "" {
			booking = "-"
		}
		fmt.Printf("[%s] %s attempt %s booking %s\n", e.Type, e.FlightKey, r.Header.Get("x-flightbyte-delivery-attempt"), booking)
		go handle(e)
	})

	log.Printf("receiving FlightByte webhooks on http://localhost:%s", port)
	log.Fatal(http.ListenAndServe(":"+port, nil))
}
