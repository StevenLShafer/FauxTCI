// FauxTCI: the transport between the pump's controller and the TCI API.
//
// The pump (js/pump.js) forms a request body of docs/tci-api.md section 4 and
// hands it to a transport; the transport answers with { status, body } the
// way an HTTP client would, so the pump treats the in-page controller and a
// real stanpumpR server identically (the section 7 safety contract applies
// to both).  Two modes:
//
//   local  the in-page controller, tciNextRate() from js/tci.js, called after
//          a setTimeout of zero so that the answer arrives asynchronously as
//          a network answer does, and never inside the caller's own turn.
//          The body goes through JSON.stringify/JSON.parse on the way in and
//          out, as it would on a wire, so the server never shares an object
//          with the pump and the numbers are exactly what the JSON carries.
//   http   fetch() to <baseUrl>/tci/v1/drugs/<drug>/rate, a real
//          stanpumpR::run_tci_api() server.  A network failure, a timeout or
//          an unparsable body is reported as status 0 with no body, which
//          the pump treats as "no response" (section 7, rule 5).
//
// Drafted by Claude Code, 2026-10-12, at the request of Steven L. Shafer.

import { tciNextRate, tciApiHealth, TciApiError, errorBody } from "./tci.js";

/** The description of the in-page transport, shown in the API panel header. */
export const LOCAL_TRANSPORT_LABEL = "in-page controller: a JavaScript port of the stanpumpR TCI API";

// A wire: the body as the other side would receive it from the R server,
// whose jsonlite::toJSON(digits = NA) writes numbers to 15 significant digits
// (the fixtures' j15() does the same), so a mass total that JavaScript
// prints as 60.900000000000006 is received as 60.9, as it would be from R.
const WIRE_DIGITS = 15;
const overTheWire = (x) => JSON.parse(JSON.stringify(x, (key, value) =>
  (typeof value === "number" && Number.isFinite(value) ? Number(value.toPrecision(WIRE_DIGITS)) : value)));

const nowMs = () => (typeof performance !== "undefined" && performance.now ? performance.now() : Date.now());

/**
 * Build a transport: `makeTransport({ mode: "local" })` for the in-page
 * controller, `makeTransport({ mode: "http", baseUrl })` for a stanpumpR
 * server.  The result has `mode`, `baseUrl`, `label` (for the page header),
 * `lastRoundTripMs` (the measured round trip of the last call, 0 for local),
 * `send(drug, body, { receivedAt })` -> Promise<{ status, body, roundTripMs,
 * error }>, which never rejects, and `health()` -> Promise<{ status, body }>
 * for the liveness probe.  `receivedAt` (milliseconds since the epoch on the
 * caller's clock) is what the local server reports as its own clock, so that
 * the simulated case runs on one clock, as the API requires.
 */
export function makeTransport({ mode = "local", baseUrl = "" } = {}) {
  if (mode === "local") return localTransport();
  if (mode === "http") return httpTransport(baseUrl);
  throw new Error(`makeTransport: unknown mode ${JSON.stringify(mode)}; use "local" or "http"`);
}

// The in-page controller behind an asynchronous boundary.
function localTransport() {
  const transport = {
    mode: "local",
    baseUrl: null,
    label: LOCAL_TRANSPORT_LABEL,
    lastRoundTripMs: 0,
    send(drug, body, { receivedAt } = {}) {
      return new Promise((resolve) => {
        setTimeout(() => {
          const received = typeof receivedAt === "number" ? receivedAt : Date.now();
          let out;
          try {
            const response = tciNextRate(overTheWire(body), received, { pathDrug: drug });
            out = { status: 200, body: overTheWire(response), roundTripMs: 0, error: null };
          } catch (e) {
            // The router's mapping: an API error keeps its status, anything
            // else is 500 INTERNAL, both with the section 6.3 body.
            const status = e instanceof TciApiError ? e.status : 500;
            out = { status, body: overTheWire(errorBody(e, received, received)), roundTripMs: 0, error: null };
          }
          transport.lastRoundTripMs = 0;
          resolve(out);
        }, 0);
      });
    },
    health() {
      return Promise.resolve({ status: 200, body: tciApiHealth() });
    },
  };
  return transport;
}

// A real server over fetch().
function httpTransport(baseUrl) {
  const root = String(baseUrl || "").replace(/\/+$/, "");
  const transport = {
    mode: "http",
    baseUrl: root,
    label: `HTTP: ${root}`,
    lastRoundTripMs: null,
    async send(drug, body) {
      const url = `${root}/tci/v1/drugs/${encodeURIComponent(drug)}/rate`;
      const t0 = nowMs();
      // A hung request must not stay pending for ever: an answer later than
      // the request's own interval is of no use (the next request is due by
      // then), so the call is abandoned there and reported as no response.
      const interval = body && body.timing && Number.isFinite(body.timing.interval) ? body.timing.interval : 10;
      const init = {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      };
      if (typeof AbortSignal !== "undefined" && typeof AbortSignal.timeout === "function") {
        init.signal = AbortSignal.timeout(Math.max(1, Math.round(interval * 1000)));
      }
      const timedOut = (e) => e && e.name === "TimeoutError";
      let res;
      try {
        res = await fetch(url, init);
      } catch (e) {
        // Rule 5: a timeout, a TLS failure or a refused connection is no response.
        transport.lastRoundTripMs = nowMs() - t0;
        const error = timedOut(e) ? "timeout" : `network: ${e && e.message ? e.message : e}`;
        return { status: 0, body: null, roundTripMs: transport.lastRoundTripMs, error };
      }
      let text = "";
      let parsed = null;
      let error = null;
      try {
        text = await res.text();
        parsed = JSON.parse(text);
      } catch (e) {
        // A truncated or unparsable body is no response either, whatever the status.
        parsed = null;
        error = timedOut(e) ? "timeout" : `unparsable body: ${e && e.message ? e.message : e}`;
      }
      transport.lastRoundTripMs = nowMs() - t0;
      return { status: parsed === null ? 0 : res.status, body: parsed, roundTripMs: transport.lastRoundTripMs, error };
    },
    async health() {
      try {
        const res = await fetch(`${root}/tci/v1/health`);
        const body = await res.json();
        return { status: res.status, body };
      } catch (e) {
        return { status: 0, body: null, error: `network: ${e && e.message ? e.message : e}` };
      }
    },
  };
  return transport;
}
