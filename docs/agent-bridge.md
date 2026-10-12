# Agent bridge host reference

The agent bridge exposes the current foreground coordinator's Pitako workers to
a local host. Reads and change hints need no coordinator model turn. The bridge
uses the existing worker controller, not a second worker store or scheduler.

The supported client entry is ordinary ESM with TypeScript declarations:

```js
import { connect } from "pitako/extensions/agent/bridge/client.js";
```

Import is passive. It does not load extension factories, read settings, start Pi,
or open a socket. The host client needs no Bun, Jiti, TypeScript loader, or runtime
compilation. The package declares Node `>=22.19.0`. The installed native client
observations used Node v25.2.1, not every supported Node version.

## Launch and connect

With Pitako installed and enabled in Pi, a host starts foreground native RPC:

```sh
bridge_root=$(mktemp -d /tmp/pb.XXXXXX)
pi --mode rpc --pitako-agent-bridge="$bridge_root"
```

See [Install into Pi](../README.md#install-into-pi) for package loading.
The host owns `bridge_root`. It must be an existing, empty, absolute, canonical
directory with mode `0700`, owned by the current OS user, with no symlinked path.
The generated socket path must fit 103 UTF-8 bytes. A short root avoids the Unix
socket path limit.

The optional launch flag
`--pitako-agent-bridge-grants=history,route,control` sets immutable permission
ceilings. Its value is a unique comma-separated subset of those names. Omission
or an empty value permits none. A ceiling alone enables neither raw reads nor
control. Each connection starts with a fresh read-only view.

The bridge starts only during foreground RPC `session_start` when its flag is
present and startup succeeds. Factory loading alone, child sessions, and non-RPC
sessions do not start it. Pi's native RPC stdout remains Pi protocol records.
Bridge messages use a separate authenticated Unix socket.

On readiness, the broker atomically publishes `descriptor.json` in the private
root without overwriting an existing file. The descriptor and generated socket
have mode `0600`. Descriptor version 1 contains `transport: "unix"`, `socket`,
`token`, `owner`, `grants`, and `capabilities`. The owner contains `processId`,
`coordinatorSessionId`, and `epoch`. Capabilities name implemented operations,
not permissions already activated.

The host correlates this native Pi RPC request with its successful response:

```json
{"id":"host-state","type":"get_state"}
```

The response's `data.sessionId` supplies `expectedSessionId`. It is independent
of the descriptor, not a value copied from it. No prompt or coordinator provider
call is needed. Native Pi RPC does not accept arbitrary Pitako extension commands.

For example, this Node consumer takes the absolute descriptor path and the
correlated session ID as arguments:

```js
import { connect } from "pitako/extensions/agent/bridge/client.js";

const client = await connect(process.argv[2], {
	expectedSessionId: process.argv[3],
});
try {
	const firstPage = await client.list();
	// Pass firstPage to the host's worker display.
} finally {
	await client.disconnect();
}
```

`connect(descriptorPath, { expectedSessionId, resume? })` validates the private
same-user directory, descriptor, socket, version, and expected session. The
server authenticates the token and owner. The returned `BridgeClient` exposes
`owner`, `capabilities`, and a private `lease`.

Neither the descriptor authentication token nor `lease.resumeToken` belongs in
logs, model context, native history, or public output. A host does not need to
print or rewrite the descriptor to connect.

## Ordinary worker reads

These reads are scoped to the current owner. They do not consume results, release
Team roles, accept workflow completion, or modify native history. Physical
settlement, not a read, releases roster occupancy and activates automatic result
handoff. `agent_result` and `team_result` are optional complete diagnostic re-reads,
not consuming acknowledgements. List rows and detail metadata expose collection,
bookkeeping, delivery, continuation, and observed handoff acknowledgement separately.

| Client operation | Returned data and continuation |
| --- | --- |
| `list(after?, revision?)` | `WorkerList` with `owner`, `revision`, `items`, and nullable `cursor`. Continuation uses `cursor` as `after` and carries the first page's `revision`. |
| `detail(id, cursor?)` | Ready detail with `ref`, authoritative `status`, earlier `observedStatus`, separate `workbrief` and `metadata` text pages, `nextBrief`, `nextMetadata`, and `controls`. Unknown targets reject. |
| `requests(id, cursor?)` | SDK-observed request metadata as a JSON text page, with `ref` and nullable `next`. A changed projection invalidates its digest-bound cursor. |
| `activity(ref, cursor?)` | Availability or a ready event page with `ref` and `next`. The cursor's `after` follows the returned event sequence. `page.more` indicates more retained events. |
| `result(ref, cursor?)` | Availability or a non-consuming terminal result with text and metadata pages, `nextText`, and `nextMetadata`. |

List pages contain at most 50 rows and may contain fewer under the byte budget.
Task text in a list row is a preview, not the complete brief. A stale list
revision produces `stale_cursor`. A new first page starts a new traversal.

The following helper keeps one revision across the list:

```ts
import type { BridgeClient } from "pitako/extensions/agent/bridge/client.js";

async function listWorkers(client: BridgeClient) {
	const first = await client.list();
	const items = [...first.items];
	let cursor = first.cursor;
	while (cursor !== null) {
		const page = await client.list(cursor, first.revision);
		items.push(...page.items);
		cursor = page.cursor;
	}
	return items;
}
```

The host discards this partial traversal on `stale_cursor`, rather than combining
different revisions.

Read references bind the owner, worker source, instance, logical attempt, and
observed native identity when available. Cursors are untrusted continuation
data, not control authority. Replacement attempts or native bindings invalidate
old references. The host preserves each returned cursor and passes it only to
its corresponding operation and section.

`TextPage` contains `text`, `offset`, and nullable `nextOffset`. Offsets use
JavaScript UTF-16 code units, not byte counts. Each page has at most 1,024 code
units. Brief and detail metadata have independent cursors. Result text and
result metadata also have independent cursors. A call that continues one
section returns the other section's first page again.

For example, this helper assembles only the original brief:

```ts
import type { BridgeClient } from "pitako/extensions/agent/bridge/client.js";

async function readBrief(client: BridgeClient, id: string) {
	let detail = await client.detail(id);
	let text = detail.workbrief.text;
	while (detail.nextBrief !== null) {
		detail = await client.detail(id, detail.nextBrief);
		text += detail.workbrief.text;
	}
	return text;
}
```

Detail metadata, request metadata, result metadata, and captured raw routing are
JSON serialized into text pages. The host concatenates the selected section's
pages before `JSON.parse`. A partial page is not a complete metadata object.
Detail metadata can change during live reads. Its cursor binds identity and
offset, not an immutable metadata snapshot.

Selected or requested settings, activated settings, and SDK-observed requests
are distinct facts. A selection does not prove activation or a provider request.
Missing observations remain unavailable. SDK options do not reveal provider
internals or returned service tier. `returned_service_tier` remains
`"unavailable"` even when a fast tier was requested.

Activity is coalesced event-only evidence, with native references, interaction
receipts, and `gaps`. It is not exact replay or a complete persisted transcript.
Retained terminal pages contain plain data, not live SDK handles.
Availability includes `pending`, `unavailable` with a reason, `evicted`,
`stale_reference`, `stale_owner`, and `invalid_cursor`. Other stale or invalid
reads can reject with `BridgeError`. Synchronous `agent_run` has no supported
retained activity or result producer and reports `unsupported_kind`.
A terminal display status alone does not establish a ready settled result.

## Change subscriptions

`subscribe(listener)` returns a `BridgeSubscription` with `subscriptionId`,
`snapshot`, `active`, `refresh()`, and `dispose()`. Subscription installation and
the initial snapshot have no missed-change window. The snapshot is a `WorkerList`
first page and can itself require continuation through `client.list`.

Every `ChangeHint` has `refreshRequired: true`, the owner, the subscription ID,
and a monotonically increasing `revision`. Its `gap` reports a nonconsecutive
revision. Hints can coalesce. They are not a replay log.

Every hint requires an authoritative refresh. `refresh()` returns a fresh list
first page, not all pages. A gap or reconnect also requires refresh. The client
does not poll, reconnect, resubscribe, or replay automatically. Hosts own their
refresh scheduling and must settle asynchronous callbacks before cleanup.

`dispose()` silences callbacks synchronously, then joins server disposal.
It is idempotent. `disconnect()` is also owned and idempotent. A disconnect
revokes that view and its subscription, not the workers.

## Scoped history and sensitive reads

`historyList(options?)` is an ordinary metadata read. Options are `workerId`,
`cursor`, and `limit`. With no `workerId`, scope is the current coordinator's
worker histories. `workerId` narrows scope to one owned instance, not an assignment
ID. Metadata is provenance, not permission to open a filesystem path.

`historyRead(options)` requires `historyId`. It also accepts `groupId` and the
list options. IDs come from scoped metadata. Continuation preserves the same
selectors and the returned cursor. The default limit is 50, and the maximum is
200. Byte limits can shorten a page.

Raw worker history requires both a launch `history` ceiling and a fresh
`grant("history", true)`. Raw routing requires both the `route` ceiling and a
fresh `grant("route", true)`. Neither acknowledgement can elevate a ceiling:

```ts
import type { BridgeClient } from "pitako/extensions/agent/bridge/client.js";

async function readSensitiveFirstPages(
	client: BridgeClient,
	workerId: string,
	historyId: string,
	groupId: string,
) {
	await client.grant("history", true);
	const history = await client.historyRead({ workerId, historyId, groupId });
	await client.grant("route", true);
	const route = await client.routeRead(workerId);
	return { history, route };
}
```

History pages contain `items`, `diagnostics`, and nullable `cursor`. Each raw
fragment has base64 `data`, `entryOffset`, `byteOffset`, `endsEntry`, and a
`validation` state. Ordered base64 decoding and byte concatenation across all
pages preserve exact native bytes, including malformed bytes. Text decoding
and JSON reserialization do not. Diagnostics distinguish missing, pruned,
unreadable, corrupt, and out-of-scope data. Empty items without examination of
diagnostics and cursor do not prove a successful complete read.

`routeRead(id, offset?)` returns `state` and a text `page`. Continuation passes
`page.nextOffset` as `offset` for the same worker. States are `captured`,
`not-routed`, and `unavailable`. A read does not reroute a worker. Actual installed
observations included `not-routed` and `unavailable`, not a production routing
invocation.

The bridge accepts no global history scope, coordinator transcript source,
arbitrary path, or general file catalog. The broader foreground history tools
have different authority. See [Worker history](worker-history.md).
Reconnect resets both sensitive acknowledgements.

## Explicit worker control

Control requires the immutable `control` ceiling and explicit
`grant("control", true, selection)` for a current controllable worker.
`detail(id).controls.selection` supplies the complete `AgentSelection`.
That selection binds process, coordinator session, epoch, target, instance,
generation, history ID, and native session ID. A Team target also binds its
assignment ID. Missing selection has a reason. Read references are not substitutes.

Activation invokes the current controller's checks. Input and cancellation
recheck the selection at admission. A replaced, terminal, synchronous, foreign,
or retired target does not gain authority from an old selection.

`input(selection, { intent, text, decisionId? }, sequence)` accepts only `query`
or `steer`. Query asks for context. Steer supplies an in-scope correction relative
to the original WorkBrief. Input is a note at a later native steering boundary,
after current tools finish. It is not a command, replacement prompt, follow-up
execution, or interruption of a running command. `decisionId` is an optional
correlation label, not authorization.

For one deliberate decision, the host supplies a sequence it has allocated:

```ts
import type { BridgeClient } from "pitako/extensions/agent/bridge/client.js";

async function sendQuery(client: BridgeClient, id: string, sequence: number) {
	const detail = await client.detail(id);
	const selection = detail.controls.selection;
	if (!selection) throw new Error("Worker is not controllable");
	await client.grant("control", true, selection);
	return client.input(selection, {
		intent: "query",
		text: "What context is missing from the original WorkBrief?",
	}, sequence);
}
```

`cancel(selection, sequence)` requests cancellation through the same current
authority. A recorded cancellation receipt with native `status: "requested"`
does not establish physical settlement, native disposal, or result readiness.
The host observes those separately.

The bridge cannot spawn workers, invoke arbitrary tools or shell commands,
change models, operate the Board, or read general plan and verification evidence.

## Mutation receipts and explicit reconnect

The lease is `{ clientId, resumeToken, highWater }`. `highWater` is the value at
connect, not a live counter. Each later sequence is an explicit new client
decision, a positive safe integer above the consumed high-water mark.
The host tracks its allocations. Repeatedly computing `client.lease.highWater + 1`
would reuse a stale value.

The server records admission before the native effect. The same retained
sequence and payload return the existing status without repeating the effect.
A changed payload at that retained sequence rejects with `sequence_conflict`.
Receipt eviction does not make a consumed sequence available again.
Only one mutation per lease can perform native work at a time. A later sequence
admitted while work is pending records a `busy` error and remains consumed.

`input`, `cancel`, and `requestStatus(sequence)` return `MutationStatus`:

| State | Meaning |
| --- | --- |
| `pending` | The admitted operation has not yet recorded its outcome. |
| `recorded` | The receipt is retained. It is an input receipt, cancellation request, or classified error with a code. |
| `outcome_unknown` | The sequence is consumed, but its outcome is unavailable. It is not permission to retry. |
| `not_admitted` | This current logical lease has not admitted that sequence. It says nothing about a lost operation under an old owner or different lease. |

An input receipt's native status is `queued`, `handled`, `rejected`, or
`unconfirmed`. Queued proves admission. Handled proves input-hook consumption.
Neither proves an answer, arbitrary provider delivery, or adequate correction.
Rejected reports nonacceptance. Unconfirmed reports closure without delivery or
answer proof. `candidateAnswer` is a possible linkage, not an adequacy judgment.

After response loss, the host uses its prior private lease only for explicit
resume and lookup. The following helper reconnects after the old connection
has closed. It performs no mutation or grant:

```ts
import {
	connect,
	type ResumeLease,
} from "pitako/extensions/agent/bridge/client.js";

async function lookupAfterLoss(
	descriptorPath: string,
	expectedSessionId: string,
	resume: ResumeLease,
	sequence: number,
) {
	const client = await connect(descriptorPath, { expectedSessionId, resume });
	try {
		return await client.requestStatus(sequence);
	} finally {
		await client.disconnect();
	}
}
```

Resume preserves retained lookup on the same logical lease. It restores no
grants, control activation, or subscriptions. The host refreshes reads and
reobserves a selection before any deliberate later control decision. Resubmission
or advancing the sequence after an unknown outcome is never a transport retry.

An active old connection can produce `busy` on resume. An expired or unknown
resume token produces `lease_expired`. Transport loss, timeout, or process loss
is not proof that a mutation failed. The client does not silently resend, advance
a sequence, or retry with a new token. Owner retirement invalidates old live
authority. Process restart or session replacement provides no recovery of
worker execution and no automatic replay.

## Limits and trust boundary

These limits are fixed, not requests for unbounded buffering:

| Resource | Limit |
| --- | --- |
| Logical clients per owner | 16 |
| Active socket connections in total | 4 |
| Active subscriptions per connection | 1 |
| Outstanding requests per connection | 8 |
| Latest mutation receipts per logical client | 32, plus the consumed high-water mark |
| Disconnected lease lifetime | 5 idle minutes, beginning only after accepted work settles |
| Complete frame | 64 KiB |
| Complete UTF-8 reply | 48 KiB, including the envelope and LF |
| Outbound queue | 256 KiB |
| Input text | 16 KiB UTF-8, nonblank |
| Decision ID | 1,024 UTF-8 bytes |
| Descriptor file | 16 KiB |
| Serialized read reference | 4,096 UTF-8 bytes |
| Serialized control selection | 8,192 UTF-8 bytes |
| Terminal activity retention | 128 snapshots, 64 KiB each, 8 MiB total |

Text-page offsets and lengths use code units as described above. Transport,
identity, input, and retention byte budgets are not character counts.
Authoritative readers bound activity pages. The broker validates the complete
envelope and reports `oversized` if it exceeds the reply budget. It does not
subdivide an oversized activity reply. A slow peer can disconnect when its
queue exceeds the cap. The client has a 15-second request timeout and requires
explicit connect after transport failure.

Terminal activity retention is bounded and can evict data while ordinary row
metadata remains. Owner retirement removes its retained snapshots. Native
history has its own [retention and capture gaps](worker-history.md). Neither
retained activity nor a reconnectable lease is a durable worker queue or delivery
guarantee.

The bridge trusts the same OS user in a shared Unix and filesystem namespace.
Private permissions and tokens do not sandbox other code running as that user.
Normal retirement revokes admission before cleanup waits. Cleanup joins owned
work and closes the broker. It removes only files whose ownership still matches.
Uncertain ownership leaves diagnostic resources rather than deleting replacements.
There is no cleanup guarantee
after SIGKILL or hostile same-user path substitution. The host owns the private
directory and removes it only after the process and its owned work have settled.

There is no Windows, TCP, browser, remote-access, global-discovery, or T3 path
mapping support. This is the Pitako host API, not a shipped T3Code integration.
Worker completion wake behavior remains unchanged.
