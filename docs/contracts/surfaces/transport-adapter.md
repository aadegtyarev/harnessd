# Surface contract: transport adapter

## Boundary, consumers, and ownership

A transport adapter translates its external protocol and authenticated principal into application requests, then renders typed results and live harness events back into that protocol. The adapter owns protocol parsing, authorization, presentation, and its own polling/network lifecycle. The application runtime owns session operations and wires adapters to core; core and harness code do not import a concrete transport.

## Requests, results, and events

- `TransportAdapter.start` receives a request dispatcher and an event-subscription function. The subscription returns a disposer; adapters release subscriptions during `stop`. `start` resolves when the adapter is ready to receive requests.
- The adapter dispatches list, inspect, create, stop, submit, and cancel requests through the application boundary. Every request identifies its authenticated `principalId`; the adapter must authorize each external update before dispatch.
- Dispatch returns a typed success or safe error result. List/inspect/create return session data, submit returns the accepted `InputId`, and stop/cancel return success without inventing an input state. Unsupported capabilities and invalid requests fail explicitly; they are not silent no-ops or fallback opportunities.
- The adapter can subscribe to live `HarnessEvent`s from the runtime. Events carry supervisor `SessionId` and retain per-session order. The adapter owns mapping session identity to its authenticated principals/chats and decides which authorized recipients should see an event.
- Event and result presentation must not expose raw exceptions, prompt contents, stderr, secret values, or environment configuration. Harness uncertainty is shown with its original `InputId` and state and must never trigger an automatic resend.

## Lifecycle and failure behavior

- Runtime startup awaits each configured adapter becoming ready. If startup fails, already-started adapters and runtime resources are shut down; no partial service is reported as ready.
- Runtime shutdown rejects new dispatches, stops external transports, waits for in-flight requests, then stops live harness instances/event pumps and closes session storage. Cleanup attempts continue after independent failures and report incomplete shutdown. Shutdown is idempotent.
- Observer failure in one adapter does not block another adapter or core event delivery. Adapters should keep synchronous observers short; asynchronous notification failures are isolated and handled without leaking details.

## Security and non-goals

- A transport authenticates/authorizes before dispatch on every external command, callback, or message. The runtime does not infer authorization from a claimed `principalId`.
- This surface defines the adapter-neutral boundary only. Telegram polling, Telegram allowlists/private-chat rules, bot credential management, UI formatting, CLI UX, watchdog/recovery, and persistence of event history are specified by later milestones.

## Related contracts

- [Core session management](core-session-management.md)
- [Pi RPC harness](pi-rpc-harness.md)
- [Direct Node process provider](process-provider.md)
- [Harnessd v1](../features/harnessd-v1.md)
