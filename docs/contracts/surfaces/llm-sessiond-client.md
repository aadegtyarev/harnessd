# Surface contract: llm-sessiond API client

## Boundary and consumers

The standalone public client under `src/llm-sessiond/` consumes the loopback `llm-sessiond` HTTP/WebSocket API v1. It is not composed into application runtime and does not implement harnessd core ports.

## Interface and flows

`LlmSessiondClient` exposes health, harness listing, session list/get/create, input submit, cancel, stop, resume, and event subscription with an optional session filter. HTTP responses and WebSocket event envelopes are strictly runtime-validated and returned as typed API v1 shapes. Input IDs are preserved exactly. The base URL is limited to `http://127.0.0.1:<port>` with no credentials or extra path/query/fragment. Node global `fetch` and `ws` are used; both transport factories may be injected for deterministic callers/tests.

## Failures and security

Safe typed errors distinguish validated API failures (HTTP status, code, safe message), protocol/status/schema/JSON failures, and transport/timeouts. Error instances do not contain raw response bodies, prompts, or low-level exception messages. No operation is retried or replayed; `INPUT_UNCERTAIN` remains explicit. Subscription exposes close, closed, and error behavior; malformed event envelopes fail the subscription rather than being silently discarded.

## Limits and non-goals

Events remain raw typed API v1 envelopes and are not coerced into `HarnessEvent`. No domain mapping, persistence, runtime wiring, non-loopback endpoint, auth, fallback, or automatic protocol negotiation is promised.

## Related contracts

- Normative source contracts in the sibling `llm-sessiond` repository: `docs/contracts/surfaces/api-v1.md` and `session-lifecycle.md`.
- [Package release](package-release.md)
- [Feature contract](../features/llm-sessiond-client-v1.md)
