# Surface contract: transport adapter

## Boundary, consumers, and ownership

A transport adapter translates its external protocol and authenticated principal into application requests, then renders typed results and live harness events back into that protocol. The adapter owns protocol parsing, authorization, presentation, and its own polling/network lifecycle. The application runtime owns session operations and wires adapters to core; core and harness code do not import a concrete transport.

## Requests, results, and events

- `TransportAdapter.start` receives a request dispatcher and an event-subscription function, plus optional session-list and harness-catalog callbacks for startup/housekeeping and transport-neutral harness selection, and an optional session-capability callback for selected-session presentation and safe capability checks. The subscription returns a disposer; adapters release subscriptions during `stop`. `start` resolves when the adapter is ready to receive requests.
- The adapter dispatches list, inspect, create (with optional canonical harness ID and session name), rename/clear-name, stop, resume, delete, submit, cancel, session-status, model-list/model-set, and effort-list/effort-set requests through the application boundary. Harness catalog entries expose canonical IDs, aliases, metadata, and declared capabilities; transport selection passes a canonical ID through create while omission leaves configured-default resolution to core. Every request identifies its authenticated `principalId`; the adapter must authorize each external update before dispatch.
- Dispatch returns a typed success or safe error result. List/inspect/create/rename/resume return session data, submit returns the accepted `InputId`, and stop/delete/cancel/effort-set return success without inventing an input state. A submit may include transient image content; core forwards it only to the matching live harness and does not persist it. A submit addressed to a stopped session resumes its saved native session before delivering that new input; core owns this lifecycle behavior. Session status may combine saved session metadata with optional ephemeral live data; model and effort catalogs include current values when known; model-set reports whether the optional effort application was confirmed. An uncertain submit error preserves its original `InputId` when available, without exposing prompt content. An unclassified failure gets a short request reference in its safe fallback message and one journal entry containing only that reference, operation kind, allowlisted exception type, and source basename/line; the exception message and full stack are not emitted. Unsupported capabilities and invalid requests fail explicitly; they are not silent no-ops or fallback opportunities.
- An adapter may additionally implement the optional `AgentFileSendTransport.sendAgentFile` capability. When present, the application runtime may inject a session-scoped handler into a compatible harness; the request is separate from external command dispatch and must be an explicit agent action. The adapter remains responsible for authenticating/selecting recipients and validating file paths within its policy boundary.
- The adapter can subscribe to live `HarnessEvent`s from the runtime. Events carry supervisor `SessionId` and arrive in per-session order. Core may publish fixed `harness_restarting`, `harness_recovered`, and `harness_recovery_failed` lifecycle status events while it performs bounded in-process recovery; these live events do not guarantee that a corresponding status write succeeded. An adapter may batch or coalesce notifications for bounded delivery only if the relative order of retained notifications is preserved and uncertainty remains discoverable by its original `InputId`. It may suppress duplicate identical error notifications within one failure episode, provided a new error after a recovery event remains visible. The adapter owns mapping session identity to its authenticated principals/chats and decides which authorized recipients should see an event.
- Event and result presentation must not expose raw exceptions, prompt contents, stderr, secret values, or environment configuration. Harness uncertainty is shown with its original `InputId` and state and must never trigger an automatic resend.

## Lifecycle and failure behavior

- Runtime startup awaits each configured adapter becoming ready. If startup fails, already-started adapters and runtime resources are shut down; no partial service is reported as ready.
- Runtime shutdown rejects new dispatches, stops external transports, waits for in-flight requests, then stops live harness instances/event pumps and closes session storage. Cleanup attempts continue after independent failures and report incomplete shutdown. Shutdown is idempotent.
- Observer failure in one adapter does not block another adapter or core event delivery. Adapters should keep synchronous observers short; asynchronous notification failures are isolated and handled without leaking details.
- Recovery policy belongs to core `SessionManager`; a transport only presents ordered lifecycle and input-uncertainty events. Recovery is limited to a live manager and does not reattach processes after supervisor restart.

## Security and non-goals

- A transport authenticates/authorizes before dispatch on every external command, callback, or message. The runtime does not infer authorization from a claimed `principalId`.
- This surface defines the adapter-neutral boundary only. Telegram polling, Telegram allowlists/private-chat rules, bot credential management, Telegram event formatting, and CLI configuration are specified by [Telegram transport](telegram-transport.md). Persistence of event history remains out of scope.

## Related contracts

- [Core session management](core-session-management.md)
- [Pi RPC harness](pi-rpc-harness.md)
- [Direct Node process provider](process-provider.md)
