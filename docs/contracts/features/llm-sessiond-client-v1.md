# Feature contract: standalone llm-sessiond API v1 client

Status: Approved for implementation

## Goal

Add a typed public `LlmSessiondClient` for local `llm-sessiond` API v1 use.

## Scope and scenarios

- Expose health, harness, session list/get/create, input submit, cancel, stop, resume, and WebSocket event subscription.
- Validate success, error, and event envelopes strictly at runtime.
- Restrict base URLs to loopback HTTP; use global Node fetch and a stable `ws` client with injectable factories.
- Represent API, protocol/schema/status, transport, and timeout failures distinctly and safely.
- Preserve exact input IDs and never retry or replay operations.

## Non-goals

No runtime composition, SessionPort/InputPort implementation, persistence, fallback, CLI wiring, or conversion into harnessd events.

## Affected contracts

- [llm-sessiond-client](../surfaces/llm-sessiond-client.md) (new)
- [package-release](../surfaces/package-release.md)
- External normative sources: llm-sessiond API v1 and session lifecycle contracts.

## Interfaces and constraints

Public exports are scoped to `src/llm-sessiond/index.ts`. WebSocket events remain raw typed API v1 envelopes. Never expose raw response bodies, prompt text, or exceptions in safe errors. `INPUT_UNCERTAIN` remains an explicit API error.

## Acceptance and validation

Cover all methods/routes/statuses and request bodies with deterministic local HTTP/WS fixtures; test strict malformed/unknown response rejection, API status/code mapping, filtered event envelopes/close behavior, and no retries. Run focused and full project gates, audit, diff check, and <=100-line checks for new authored source/test/docs. Bump to 0.4.0 with dated changelog and lockstep dependency updates.
