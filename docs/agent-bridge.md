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
compilation. The package declares Node `>=22.19.0`. The composed offline worker
journeys used Node v26.11.1, not every supported Node version.

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

The launch flag is the bridge configuration. No TOML grant or control setting is
required. Each connection is read-only. There are no grant flags, ceilings,
activation requests, consent prompts, or permission handshakes.
Authentication allows scoped reads, never worker control.

The bridge starts only during foreground RPC `session_start` when its flag is
present and startup succeeds. Factory loading alone, child sessions, and non-RPC
sessions do not start it. Pi's native RPC stdout remains Pi protocol records.
Bridge messages use a separate authenticated Unix socket.

On readiness, the broker atomically publishes `descriptor.json` in the private
root without overwriting an existing file. The descriptor and generated socket
have mode `0600`. Descriptor version 2 contains `transport: "unix"`, `socket`,
`token`, `owner`, and `capabilities`. The owner contains `processId`,
`coordinatorSessionId`, and `epoch`. Capabilities name implemented operations,
not control authority. Protocol 1 is incompatible; there is no fallback decoder
or compatibility mode.

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

## Native background pending

`await client.backgroundPending()` sends `background.pending` with params `{}`.
The existing authenticated envelope identifies the owner; no worker references,
Lineage imports, pagination, subscription, or model turn are required. It returns
exactly one of:

```ts
type BackgroundPending =
  | { state: "pending" }
  | { state: "none" }
  | { state: "unavailable";
      reason: "unsupported" | "stale_owner" | "source_unavailable" };
```

`none` confirms absence only for this owner at the instant of reading, not future
admissions. `pending` includes accepted preparation, running attempts, held SDK
close and internal callbacks, unknown closure, and outstanding exterior delivery.
It derives from native owner/session reservations and rows, not the UI catalog,
historical roster, `resultTaken`, or a second task registry. A pre-reservation
failure is absent; accepted partial preparation stays pending through cleanup
and applicable failure delivery. Roster rollback cannot hide that native row.
Cancellation and Stop may withdraw delivery but cannot release unsettled resources.

Released protocol members need no exterior receipt. The exterior director still
counts after specialist disband until its own lifetime and close settle. Exterior
final handoffs require reconciled/inapplicable bookkeeping and incorporated
delivery unless explicitly withdrawn. Each intermediate exterior response must
independently be incorporated or explicitly withdrawn: a final receipt cannot
hide an intermediate. No interpretation, acceptance, or observed continuation
is required. Released historical rows alone do not pin. This is not a universal
`agent_run` lifetime guarantee.

The read is passive: it does not collect, acknowledge, consume results, advance
protocols, send wakes, or renew activity. Owner replacement immediately revokes
old reads and drains the old resources before admitting a new owner. Failed drain
cannot authorize a new owner's zero; rows are never transferred to a new token.

Version remains 2. `background.pending` follows `architecture.public-v1` in the
capability list. Updated validators accept only three exact, ordered snapshots:
13 base capabilities, 16 including the architecture group, or all 17 including
pending. Descriptor and connect must agree. Missing capability returns
`unavailable/unsupported` without sending an unknown operation. Incompatible
versions fail connect; the consumer classifies that failure because no client
exists yet. The broker retains authorization and stale-owner errors. Only
`backgroundPending()` maps errors to this union: retired owner to `stale_owner`;
source, transport, authentication and invalid replies to `source_unavailable`,
never to `none`. Other client methods keep their exceptions.

### T3 adoption and protection boundary

T3 must adopt the **complete updated published v2 snapshot**, both JavaScript
and TypeScript declarations, not copy this method alone. Its strict capability
reader must recognize the three exact snapshots, current optional Team identities
in worker list/detail, and architecture records including T1's
`knowledge-boundary` provenance. Existing strict vendored v2 readers are not
implicitly compatible. The historical version mismatch is not a proven incident
cause.

Both session-idle and thread-unload decisions must read native pending independently
of Lineage, `eventSink.nativeWorkers`, `childThreadId`, and checkpoints. Combine
positive native pending with ordinary T3 reasons, including `pendingWake`.
Unavailable is not false: do not turn catches into absence. Keep the existing
30-minute idle threshold and four-hour maximum pinning budget; retain diagnostic
unavailability within that budget, genuine-activity renewal, and explicit Stop.
Passive reads, reconnects and repeated diagnostics never renew the budget.

After every await, fence the same runtime process, coordinator session and owner
epoch before using the answer; discard late replies from retired owners. Connect
through the private descriptor of the real Pi process and validate ownership,
not an invented owner or a worker list fallback.

Local publication is **not integrated T3 protection**. Consumer edits are separate.
T3 still needs external integration checks: real registered `team_assign` and
`agent_spawn` with Lineage import deliberately suppressed; simulated 30-minute /
four-hour clocks and genuine renewal; specialists closed with director retained;
then exterior delivery and unload under the same owner. Also cover cancellation,
Stop, owner replacement, unavailable/incompatible bridge, and late-reply fences.
Those are externally pending T3 checks, not Pitako gates or dependency certification.

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
| `detail(id, cursor?)` | Ready diagnostic detail with `ref`, authoritative `status`, earlier `observedStatus`, separate `workbrief` and `metadata` text pages, `nextBrief`, and `nextMetadata`. Unknown targets reject. |
| `publicDetail(id, cursor?)` | `public-v1` launch metadata for `agent_spawn` and `team_assign`, distinct from diagnostic detail and event activity. |
| `publicActivity(ref, cursor?, recovery?)` | Public native conversation snapshot and signed continuation, with scoped binding, immutable revisions, explicit gaps and optional persisted recovery. |
| `publicResult(ref, cursor?)` | Authoritative, non-consuming public outcome text; independent from conversation capture closure. |
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

### Early public launch metadata

`publicDetail` requests `workers.detail` with `format: "public-v1"` over
protocol 2. Its `worker` identifies source, instance, role, coordinator session,
actual launch `toolCallId`, acceptance time, and native Team `assignmentId`,
`teamId`, `memberId`, and current `turnId` when applicable. Worker list and detail
carry the same optional identities; old captures without them remain readable.
Maintained members stay running/idle between turns and expose no settled result
until their assignment closes. Internal callers without a tool-call ID report `toolCallId: null`
and `linkage: "unlinked"`; identity is not reconstructed from routing or output.
`workbrief` preserves the original task with a separate `nextBrief` cursor.
Selected/requested settings and observed activation remain separate.

Accepted identity and the local revision are published before launch resolves,
even before history or native session allocation. Setup failure updates that
same worker. Socket delivery is scheduled independently; launch does not wait
for host acknowledgement. A host adapter must register the accepted child
before finalizing its parent turn. Handler return does not prove that the
adapter has received the child or finished its translation.

Execution, result availability and capture are independent. Native SDK capture
starts `opening`, becomes `open` once a genuine session is bound, and closes
only after shutdown, disposal, reconciliation and worker metadata settle.
Absent producers report `incomplete`/`not_captured`; projection failures report
`incomplete`/`capture_failed` without changing the authoritative worker outcome.
One invocation remains one worker. `bindings` distinguish native sessions and
generations, attempts and activated models; same-session fallback adds attempts,
while replacement sessions retain historical bindings. `nextBindings` pages
bounded binding metadata separately from `nextBrief`.
Public launch metadata contains no raw history, routing record or managed
transport secret. `agent_run` returns `unsupported_kind` from this format;
its ordinary result, history and observations remain unchanged.

### Public conversation continuation

Use a `publicDetail.bindings[i].ref` with `publicActivity`. The first call fixes
a snapshot cut at the available beginning. Drain `next` while `more` is true;
retain the final non-null `next` for future changes, including after launch
return, missed `changed` hints and reconnect under the same owner. Metadata
revisions are not conversation sequences. Owner replacement and process restart
invalidate in-memory capture cursors. Foreign workers, bindings and epochs are
rejected; historical captured references do not select the current generation.

Apply changes by record `id` and immutable `revision`. Native user/assistant
messages expose genuine entry and parent IDs; tools upsert by the genuine
`toolCallId` across start/update/end/persisted result. `order`, `nativeOrder`,
native time and `observedAt` are separate. `branch_changed` gives genuine old/new
heads; prior records remain historical, not another session's active branch.
Public `order` is allocated by the conversation owner for the available
projection, not copied from journal sequence or native file ordinal. Recovery
reserves insertion ranges around known placements; it may publish newer
revisions to rebase them. An issued revision or cut does not change.

Every wire reply including its JSON envelope is at most 48 KiB; each page has at
most 50 records. Large upserts use `kind: "fragment"`, `encoding: "base64-json"`,
record ID/revision, UTF-8 byte offsets and total bytes. Concatenate and decode the
entire record before interpreting its arguments: a partial JSON fragment is not
valid tool arguments. Retry/replay does not create another record.

Changes **and snapshots** are bounded to 4 MiB per worker and 32 MiB per owner,
counted as UTF-8 JSON bytes. Eviction reports lost ranges and `resync_required`.
Take an available fresh snapshot or explicitly call `publicActivity(ref,
undefined, true)` to recover registered persisted messages using positional
reads. Recovery never opens a new SDK session or scans unrelated archives.
Unpersisted intermediate tool updates cannot be recovered. Missing, pruned and
unsupported sources remain explicit gaps; recovery is not proof of completeness.
Placement metadata and immutable recovery recipes count against these same
budgets. Recovery synchronously freezes the observed head and registered
`FileCut` before any await, then reads bounded native ancestry metadata and
placement anchors/ranges from that cut. It materializes individual native
results as needed; live updates, reconciliation and continuation do not reread
the complete file. The file tail does not select the active branch.

Every recovery page, including fragment continuations, carries that recovery's
frozen binding, selector and capture observation. The first materialization of
a record freezes its final merged upsert bytes, including permitted retained
live arguments and the native cut's checklist decision. Repeated cursors and
later fragments reuse those bytes even if the same tool receives a live upsert.
Recovery-derived snapshots stay in the cut's recipe, not live retained records.
Loss of the recipe, materialized bytes or an admissible cut requires
`resync_required`, never reconstruction from newer live data. A rejected cut
cannot export its checklist through a subsequent live follow read.

After `resync_required`, finish a **fresh read without a cursor** before choosing
its sort domain: `state: "ready", more: false` closes that available cut; its
non-null `next` is for later changes, not another snapshot page. Sort IDs present
in the closed cut plus placeable recovery upserts, applying revisions within
each binding. Keep previously imported IDs absent from that set for consultation,
outside this sort domain; do not delete their copies or guess their interleaving.
Snapshot-present transient tools remain sortable. Recovery's `not_persisted`
means lost transient content cannot be reconstructed natively, not exclusion
of present tools. If a cut or its placement recipe is lost while paging, honor
the new `resync_required` rather than treating a partial cut as closed. This
partition uses the existing pagination facts; there is no eternal cross-loss
order guarantee or durable placement journal.

Public fields exclude thinking/signatures, instructions, Team wrappers, custom
private entries, routing, managed auth, leases and control selections. Original
WorkBrief and ordinary public text/tool arguments remain public; this is not a
universal scanner for arbitrary secrets written into those fields. Images and
binary/unknown content are represented as explicit omissions.

### Public worker checklist

Protocol 2 and `public-v1` add two optional fields, without a new operation or
permission: `todoSnapshot` on the tool variant of `PublicPayload`, and
`todoHead` on `PublicBinding` in detail and activity pages. The public types are
declared in `extensions/agent/bridge/protocol.d.ts`; the shared
`extensions/agent/bridge/protocol.js` validator admits them for broker and Node
client alike. Native resolution is private to `extensions/agent/public-todo.ts`,
with capture/recovery in `extensions/agent/public-conversation.ts`, registered
file reads in `extensions/agent/history-native.ts` and lifecycle hooks in
`extensions/agent/pi.ts`.

```ts
export type PublicTodoSnapshot = {
	format: "rpiv-todo-v1";
	tasks: Array<{
		id: number;
		identityEntryId: string;
		subject: string;
		status: "pending" | "in_progress" | "completed" | "deleted";
	}>;
};

export type PublicTodoHead =
	| { state: "ready"; sourceEntryId: string | null }
	| { state: "unavailable" };
```

Only these fields are exported; arbitrary native `details`, allocator state,
task timestamps, dependencies, owner and metadata are not checklist fields.
IDs must be positive safe integers and unique within the snapshot. A snapshot
keeps the complete membership and row order, including `deleted`, even when
the visible `todo list` text was filtered.

`todoSnapshot` describes the persisted native result at `record.nativeEntryId`.
Pre-append tool events cannot establish it or invent native identity from
`toolCallId`. Reconciliation publishes snapshots, `headEntryId` and `todoHead`
together before notifying readers. `todoHead` selects by native ancestry from
`binding.headEntryId` through all entry classes, including non-message entries;
it is not the tool with the highest public revision. Recovery of older result A
can give A a newer public revision while result B remains selected.

For each task, `identityEntryId` is the earliest native result containing its
numeric ID in that continuous membership lifetime on the selected ancestry.
Deletion retains membership and identity. An intervening snapshot without the
ID ends that lifetime; clear followed by ID reuse has a new identity. Invalid
intermediate subject/status rows do not themselves erase numeric membership.
Interpret this identity only within the existing owner, capture epoch, binding
generation, history and native session scope, not globally across workers.

Use the selector, not text, action, params or revision, to choose a checklist:

| Binding observation | Meaning |
| --- | --- |
| `todoHead: { state: "ready", sourceEntryId: "<native ID>" }` | This native result is selected. Find its `todoSnapshot` within the same binding, possibly in historical/recovered pages; do not substitute another while waiting. |
| `todoHead: { state: "ready", sourceEntryId: null }` | The complete ancestry to the root was checked and contains no matching TODO result. |
| `todoHead: { state: "unavailable" }` | Selected data is invalid, or selection/identity cannot be proven. There is no older-result fallback and no inferred empty checklist. |
| No `todoHead` field | The producer does not announce this capability; absence is not an empty checklist. |

Clear is a selected result, distinct from proven absence:

```json
{"todoSnapshot":{"format":"rpiv-todo-v1","tasks":[]}}
```

Its binding has `{"todoHead":{"state":"ready","sourceEntryId":"<clear entry ID>"}}`,
not a null source. Missing/corrupt/cyclic ancestry, ambiguous native IDs and
limits cannot establish a partial identity or silently truncate tasks.
Recovery with a head outside its frozen file cut publishes `unavailable` and
no snapshots from that cut. If rejection happens after fragments were emitted,
the continuation requires `resync_required`, not altered remaining bytes.

Task arrays are not cursor state or a separate pagination domain. Large
snapshots use the existing whole-upsert base64 JSON fragments and budgets.
Assemble the entire immutable upsert before applying the snapshot; do not
interpret partial task arrays or combine fragments from different revisions.

### Node page assembly and follow reads

This example keeps copies for one binding. It assembles UTF-8 fragments before
applying upserts, and returns the IDs observed in each finished traversal.
The host owns the lifetime and storage of `copies`.

```js
async function readAvailable(client, ref, copies, cursor, recovery = false) {
	const parts = new Map();
	const present = new Set();
	const gaps = new Set();
	let capture;
	for (;;) {
		const page = await client.publicActivity(ref, cursor, recovery);
		if (!("changes" in page)) throw new Error(`Unavailable: ${page.state}`);
		if (page.state === "resync_required") {
			return { state: page.state, gaps: page.gaps, lost: page.lost };
		}
		for (const gap of page.gaps) gaps.add(gap);
		capture = page.capture;
		for (const change of page.changes) {
			let record;
			if (change.kind === "fragment") {
				const key = `${change.id}:${change.revision}`;
				const part = parts.get(key) ?? { bytes: 0, chunks: [] };
				if (part.bytes !== change.byteOffset) throw new Error("Fragment offset");
				const chunk = Buffer.from(change.data, "base64");
				part.chunks.push(chunk);
				part.bytes += chunk.length;
				parts.set(key, part);
				if (part.bytes !== change.totalBytes) continue;
				record = JSON.parse(Buffer.concat(part.chunks).toString("utf8")).record;
				parts.delete(key);
			} else {
				record = change.record;
			}
			present.add(record.id);
			const prior = copies.get(record.id);
			if (!prior || record.revision > prior.revision) copies.set(record.id, record);
		}
		if (!page.more) {
			if (parts.size) throw new Error("Incomplete record");
			return { state: "ready", next: page.next, present, gaps: [...gaps], capture };
		}
		if (!page.next) throw new Error("Missing continuation");
		cursor = page.next;
	}
}

const detail = await client.publicDetail(workerId);
if (!("bindings" in detail)) throw new Error(detail.reason); // agent_run is unsupported.
const binding = detail.bindings[0];
if (!binding) throw new Error("Native binding not yet available");
const copies = new Map();
let read = await readAvailable(client, binding.ref, copies);
if (read.state === "ready" && read.next) {
	// Later, after a hint or an explicit refresh, not a tight polling loop:
	read = await readAvailable(client, binding.ref, copies, read.next);
}
```

The helper does not select a sort domain, reconnect, or schedule reads.
After resync, a fresh call without a cursor returns the closed available set
only when `state` is `ready`. The host uses that traversal's `present`, not
all keys in `copies`, as the initial sortable set. Placeable recovery upserts
can add IDs. Copies absent from the set remain available for consultation.
Order is comparable within a binding, not across workers or generations.

Recovery is explicit:

```js
const fresh = await readAvailable(client, binding.ref, copies);
const recovery = await readAvailable(client, binding.ref, copies, undefined, true);
// Preserve both observations and their gaps. Neither erases older copies.
```

A recovery page with `more: false` ends pagination, not loss.
`capture.state: "incomplete"` with `gaps: ["capture_failed"]` is a failed
capture observation even if registered native messages are recoverable.
`not_persisted` reports missing transient recovery data. It does not exclude
transient records already present in the closed fresh cut from its sort.

Terminal reads remain independent:

```js
const terminal = await client.publicDetail(workerId);
const outcome = await client.publicResult(terminal.ref);
// outcome.state can be "pending" while shutdown or disposal still runs.
// Reading an available outcome again does not consume coordinator delivery.
// terminal.lifecycle.capture can be "incomplete" even for completed execution.
```

`branch_changed` records describe native head transitions. The host retains
historical messages instead of treating every imported record as an active
branch message. A replacement binding needs its own reference and read state.
Same-session fallback remains in its existing binding.

## Passive Architecture tables

The optional ordered capability group is `architecture.list`, `architecture.read`,
`architecture.public-v1`. The bridge envelope stays version **2**. The updated
public ESM client accepts either the original canonical v2 capabilities or that
list plus the entire group; malformed or partial groups are rejected. It connects
to original v2 servers and rejects unsupported Architecture calls locally without
sending them. Previously distributed strict clients reject the extended server
list: consumers must update their client. There is no per-client negotiation or
v3 fallback.

```js
if (client.capabilities.includes("architecture.public-v1")) {
	let catalog = await client.listArchitectures();
	if (catalog.state !== "ready") throw new Error(catalog.state);
	for (;;) {
		for (const item of catalog.items) {
			// item.ref identifies a table; it grants no execution authority.
			const page = await client.readArchitecture(item.ref);
			// Drain page.next before interpreting the complete snapshot.
		}
		if (catalog.next === null) break;
		catalog = await client.listArchitectures(catalog.next);
		if (catalog.state !== "ready") throw new Error(catalog.state);
	}
}
```

`listArchitectures(cursor?)` sends `architecture.list` with `{ cursor? }`.
`readArchitecture(ref, cursor?)` sends `architecture.read` with `{ ref, cursor? }`.
Both are passive reads. `ArchitectureRef` is the owner plus `kind: "architecture"`
and `roomId`. It is distinct from a worker/conversation reference:

```json
{"kind":"architecture","processId":"p","coordinatorSessionId":"c","epoch":"e","roomId":"r"}
```

The public declarations in `client.d.ts` re-export `ArchitectureRef`,
`ArchitectureCatalog`, `ArchitectureRead`, `ArchitecturePage`,
`ArchitectureRecord`, `ArchitectureFragment`, `ArchitectureLifecycle`,
`PublicArchitectureMessage`, `PublicArchitectureBody` and `PublicSynthesisBody`.
They import no Pi, TypeBox, runtime or TypeScript source at runtime.

### Sources and records

Accepted tables are registered before asynchronous preparation. A catalog can
therefore contain a table without a runtime or native conversation, including
one started before the consumer connected. Empty captured catalogs return
`items: []`, not `not_captured`.

| Record kind | Identity and authoritative content |
| --- | --- |
| `room` | `id: roomId`, `mode`, start `origin` (coordinator session/tool call and director identities), `goalSource`, `lifecycle`, `pendingDoubtIds`. |
| `member` | `id: memberId`, real Team `assignmentId`, `instanceId`, `roleId`, `function` (director/specialist/support), admission `ordinal`/`admittedAt`, `mandate`, `execution`, optional `workerRef`, known `conversationRefs`. |
| `publication` | Stable Message `id` and the full original `message`, captured only when the runtime registers a settled turn. |
| `control` | Stable `id`, acceptance `order`, `action`, optional `text`, author coordinator session/tool call, pending or applied `application`. |
| `failure` | Stable `id`, `phase`, error text, and known member/assignment/stage/round context. |
| `outcome` | `id: "final"`, `source: "background-settlement"`, definitive `status`, and typed synthesis or definitive text `content`. |

The roster comes from real Team assignments, not composition proposals or
transcripts. Failed admitted specialists, supports and superseded members remain
present. Known `compositionMessageId` and `supersededByCompositionId` link
compositions, never invented one-to-one replacements. Admission rollback creates
no accepted member. Absence of a conversation does not remove a member.

`goalSource: { kind: "worker-workbrief", instanceId }` identifies the root's
existing public WorkBrief, not a second goal copy. Read it using
`client.publicDetail(instanceId)` and each returned `nextBrief`, checking
`workbrief.source` and returned offsets and concatenating only `workbrief.text`.
The original Markdown (including Unicode, CRLF and escapes) is the document;
the technical stage prompt is not. The director's mandate references that root
WorkBrief; other mandates carry actual `TeamAssignment.task`. A participant's
inherited origin must not be substituted for its mandate.

`PublicArchitectureMessage` retains Message identity, ordinal, room, assignment,
member, author, stage, snapshot, optional round, turn/attempt, `body`, `native`
and generated `doubts`. The Body union retains `composition`, `preparation`,
`contribution`, `decision`, `answer`, `consultation-plan`,
`consultation-response`, `knowledge` and `synthesis`, with their original fields
and references, not UI-renamed content. Provisional `architecture_submit` receipts
are absent. A recorded publication survives later semantic validation or closure
failure; that failure is separate. `native.persistence: "unconfirmed"` never
proves native persistence.

Only accepted coordinator controls appear. Context/priorities remain pending
until consumed at the existing protocol boundary. Finish/stop apply at their
flag/revocation boundary, including stop before runtime (`stage: null`). Applied
stage/round does not prove model receipt; controls never rewrite the initial goal.

### Outcome, physical closure and capture

Stage, round, protocol state, outcome availability, physical closure and capture
are independent. A published synthesis is the unadjusted settled Message clone.
The runtime separately deposits its typed adjusted synthesis, bound internally
to the exact driver result. Background selects it only after that driver resolves
and finalization does not replace it. A failed outcome may contain a typed
`partial` synthesis. Driver rejection, cancellation replacement or director
close failure instead exports definitive settled text. No result string is parsed
or matched to infer the typed candidate.

For example, a synthesis can coexist with a pending director disposal:

```json
{"stage":"closing","round":2,"protocolState":"running","outcome":"pending","closure":{"state":"pending","members":"released","director":"pending"}}
```

Disband of subordinate Team members does not close the director. Aggregate
`released` requires settled preparation/cleanup and positive closure of each
created lifetime, with no uncertainty. An ordinary pre-runtime preparation
failure after cleanup, `workerStarted === false` and no runtime proves members
and director `not-created`, not disposed; aggregate closure may then be released.
`AgentClosureError` remains unknown. A close failure after synthesis preserves
that publication and adds a failed text outcome with unknown closure.
`outcome: "unavailable"` means an explicit missing definitive capture, not a
worker error disguised as absence.

`capture.state` is `open`, `closed` or `incomplete`, with `finalCut` and explicit
`not_captured`/`capture_failed` gaps. Closed means final capture is complete and
no producers remain, not physical release. Capture faults do not change execution,
accepted controls, outcomes or ordinary coordinator delivery. Owner/evaluation
retirement yields `stale_owner` or disconnect, never a fabricated `retired` state.

### Frozen pages, reconstruction and refresh

The first synchronous read freezes a cut. A catalog page has `format:
"architecture-public-v1"`, `state: "ready"`, `owner`, `snapshotId`, controller
revision `cut`, `items`, and nullable `next`. A room page replaces owner/items with
`ref`, `capture` and `records`. Continuation and replay retain that cut even while
execution advances. Debate `message.ordinal` is separate from controller `cut`.
`next: null` ends this snapshot, not the table's execution.

Oversized records are serialized once and fragmented by UTF-8 bytes, with
`kind: "fragment"`, `recordId`, `encoding: "base64-json"`, `byteOffset`,
`totalBytes` and base64 `data`. Assemble bytes before decoding JSON:

```js
async function readArchitectureSnapshot(client, ref) {
	let cursor, snapshotId;
	const records = [], parts = new Map();
	for (;;) {
		const page = await client.readArchitecture(ref, cursor);
		if (page.state !== "ready") return page; // Do not treat a partial cut as complete.
		snapshotId ??= page.snapshotId;
		if (snapshotId !== page.snapshotId) throw new Error("Mixed snapshots");
		for (const record of page.records) {
			if (record.kind !== "fragment") { records.push(record); continue; }
			const part = parts.get(record.recordId) ?? { size: 0, chunks: [] };
			if (part.size !== record.byteOffset) throw new Error("Fragment offset");
			const chunk = Buffer.from(record.data, "base64");
			part.chunks.push(chunk); part.size += chunk.length;
			parts.set(record.recordId, part);
			if (part.size === record.totalBytes) {
				records.push(JSON.parse(Buffer.concat(part.chunks).toString("utf8")));
				parts.delete(record.recordId);
			}
		}
		if (page.next === null) {
			if (parts.size) throw new Error("Incomplete record");
			return { ...page, records };
		}
		cursor = page.next;
	}
}
```

Each result is at most 40 KiB and also subtracts the exact envelope plus LF from
the 48 KiB bridge ceiling. Raw fragments are at most 12 KiB before base64.
Existing 64 KiB framing, queue and pending-request limits still apply. Each view
retains one catalog and one room snapshot, each at most 4 MiB; all snapshots per
owner total at most 32 MiB. These limits bound frozen exports, not running table
content or authority. Five-minute expiration is measured from creation and
checked lazily. First reads replace only their own snapshot class in that view;
final pages retain snapshots for retry. Disconnect/view close/owner revoke frees
storage. Reservation failure returns `snapshot_oversized`, never truncation or
eviction of another consumer.

Domain absence is `{ state: "unavailable", reason: "unknown_room" |
"not_captured" | "snapshot_oversized" }`; `unknown_room` is room-only. Partial
capture may still be ready with incomplete/gaps. Owner and cursor errors may
reject as `BridgeError` (`stale_owner`, `stale_cursor`, `invalid_cursor`). Another
view/room cursor is invalid; expired or replaced snapshots are stale. Owner
checks precede room lookup. Cursors are opaque, integrity-protected and bound to
owner, view, room, snapshot, position and byte offset; never edit them.

Table mutations explicitly advance the existing shared controller revision and
coalesced `changed` hints, including publication, control and closure without a
worker event. Reads and pagination do not. `subscription.refresh()` still
refreshes **workers only**. After a hint, finish or discard the previous cut,
then relist/reread tables without a cursor. After reconnect, relist and reread;
hints are not a replay log. There is no new persistence, restart recovery,
transcript inference, coordinator control or T3 UI. Preserve the last confirmed
cut and mark connection/capture gaps instead of inventing final facts.

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

## Scoped history and raw reads

`historyList(options?)` is an ordinary metadata read. Options are `workerId`,
`cursor`, and `limit`. With no `workerId`, scope is the current coordinator's
worker histories. `workerId` narrows scope to one owned instance, not an assignment
ID. Metadata is provenance, not permission to open a filesystem path.

`historyRead(options)` requires `historyId`. It also accepts `groupId` and the
list options. IDs come from scoped metadata. Continuation preserves the same
selectors and the returned cursor. The default limit is 50, and the maximum is
200. Byte limits can shorten a page.

Authenticated bridge views read scoped history and routing directly. The
internal read-only bridge policy bypasses only sensitive-read acknowledgement;
screen and Herdr views retain their own acknowledgement and control guards:

```ts
import type { BridgeClient } from "pitako/extensions/agent/bridge/client.js";

async function readSensitiveFirstPages(
	client: BridgeClient,
	workerId: string,
	historyId: string,
	groupId: string,
) {
	const history = await client.historyRead({ workerId, historyId, groupId });
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
## Read-only boundary

The bridge does not implement `input`, `cancel`, `view.grant` or
`request.status`. Such wire requests return `unsupported_method`, without
worker effects. No client mutation methods, receipts or activation are exposed.
Connecting, reading, closing a view and disconnecting cannot steer, abort or
cancel workers or change their result delivery. Normal coordinator tools,
steering and cancellation retain their existing authority and guards.

The bridge cannot spawn workers, invoke arbitrary tools or shell commands,
change models, operate the Board, or read general plan and verification evidence.

## Explicit reconnect

The private lease is `{ clientId, resumeToken }`. It supports explicit resume of
the same logical read client after the old connection closes. It carries no
mutation sequence or receipt state. Reconnect requires a fresh authoritative
read and reinstalls no subscriptions:

```ts
import {
	connect,
	type ResumeLease,
} from "pitako/extensions/agent/bridge/client.js";

async function refreshAfterLoss(
	descriptorPath: string,
	expectedSessionId: string,
	resume: ResumeLease,
) {
	const client = await connect(descriptorPath, { expectedSessionId, resume });
	try {
		return await client.list();
	} finally {
		await client.disconnect();
	}
}
```

An active old connection can produce `busy` on resume. An expired or unknown
resume token produces `lease_expired`. The client does not silently reconnect,
resend or retry with a new token. Owner retirement invalidates old read
references. Process restart or session replacement provides no recovery of
worker execution and no automatic replay.

## Limits and trust boundary

These limits are fixed, not requests for unbounded buffering:

| Resource | Limit |
| --- | --- |
| Logical clients per owner | 16 |
| Active socket connections in total | 4 |
| Active subscriptions per connection | 1 |
| Outstanding requests per connection | 8 |
| Disconnected lease lifetime | 5 idle minutes |
| Complete frame | 64 KiB |
| Complete UTF-8 reply | 48 KiB, including the envelope and LF |
| Outbound queue | 256 KiB |
| Descriptor file | 16 KiB |
| Serialized read reference | 4,096 UTF-8 bytes |
| Terminal activity retention | 128 snapshots, 64 KiB each, 8 MiB total |

Text-page offsets and lengths use code units as described above. Transport,
identity and retention byte budgets are not character counts.
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

## Reproduce the offline public boundary

From a prepared checkout root, using the prerequisites in [GATES.md](../GATES.md),
run the existing fixtures; do not launch a second SDK driver or supply real
provider credentials:

```sh
bun test ./tests/agent-public-conversation.test.ts
bun test --parallel ./tests/agent-public-todo.test.ts ./tests/agent-public-conversation.test.ts ./tests/agent-public-retention.test.ts ./tests/agent-public-sdk-premise.test.ts ./tests/agent-pi.test.ts ./tests/agent-bridge-transport.test.ts
```

The first file includes both `agent_spawn real rpiv-todo create and filtered
list native smoke` and `team_assign real rpiv-todo create and filtered list
native smoke`. They invoke the existing launch handlers/controller,
`createPiExecutor`, the real rpiv-todo extension and persisted SDK sessions.
A registered deterministic `streamSimple` emits actual `todo` calls. The
private runtime uses `refreshOnCreate: false`, `allowModelNetwork: false` and
`OFFLINE_DUMMY`, not model-network requests or paid credentials.

The fixture starts the broker and invokes
`tests/fixtures/public-conversation-reader.mjs` with Node over the published
client entry. It owns private config/agent/history/IPC roots and waits for
sessions, background attempts, callbacks, broker/controller and reader disposal
before removing them. The reader's descriptor/session/worker arguments come
from the running fixture; it is not a standalone command against another owner.

Inspect assertions and `NATIVE_TODO_SMOKE` / `NATIVE_TODO_EDGES` observations:
the filtered completed list still exports both pending tasks; public
`nativeEntryId` and `todoHead.sourceEntryId` equal the saved list result's ID;
task identities equal their saved create IDs. Deleted remains present, clear
selects an empty snapshot and reused ID 1 gets its new create entry identity.
Native navigation through non-message ancestry, proven absence, invalid
selection, compaction, registered reopen and distinct workers are exercised.

The same conversation file's other composed journeys are named
`<agent_spawn|team_assign> composes the real SDK producer, bridge and published
Node reader through live <upserts|errors> and independent closure`. They check
large UTF-8 argument fragments, immutable page replay, live updates and
independent terminal capture/result reads. The parallel group also exercises
resolver/wire admission and retention/recovery boundaries. For checklist
recovery, inspect frozen head/selector/capture, historical A versus selected B,
complete large snapshots, fragment continuation after a same-tool live upsert,
and rejected-cut/recipe-loss resync rather than mixed bytes or retained leakage.

These commands describe reproducible checks, not a claim that a particular
checkout passed. Record observed exits, assertion failures and gaps. Focused
fixtures do not replace the full typecheck-then-test procedure or independent
review in `GATES.md`, certify dependencies or demonstrate T3 ingestion/UI.

## Future T3 adapter and Lineage work

Pitako provides **lectura pública incremental disponible**: available incremental
public reads within declared capture and retention limits. It does not provide
a complete conversation or establish functioning T3 Lineage.

A separate T3 adapter needs to update its vendored protocol 2 client and remove
old bridge grant and control settings. The adapter must correlate native
`toolCallId` with the real parent turn and node, register each child before the
parent terminal, and translate and persist public messages, tools, and results.
Known live children need ingestion after the parent terminal until capture
closes or reports an explicit incomplete outcome. The main-space conversation
remains read-only. Resync must preserve old copies outside the available sort
domain described above.

This Pitako unit imports no T3 types, creates no T3 ThreadIds, writes no T3
database, and implements no T3 translation or Lineage. Offline composed checks
observe both launch handlers, real native SDK capture and the Node consumer.
They do not certify external providers, T3 ingestion, or parent-terminal timing.
