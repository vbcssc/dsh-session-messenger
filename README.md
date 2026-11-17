# @deepseek-ai/dsh-experimental-session-messenger

Status: experimental. Two model tools that deliver one message from the calling Session's main agent into the main agent of another existing Session, addressed by session id.

## Summary

`send_session_message` reaches a Session that already exists — including one this Host has not loaded — instead of a delegated child of the caller. `list_sessions` returns the exact ids the send tool accepts. A delivered message records the `session-message` source with the sending Session id, so the target's log and history attribute it to that Session rather than to the person at the keyboard.

This package is also the bundle that mounts the plugin: `dsh.bundle.patch` points at `cordis.patch.yml`, whose one layer inserts this same package under the entry id `session-messenger`. Installing the package therefore needs no sibling package and no workspace.

## Tools

| Tool | Arguments | Purpose |
| --- | --- | --- |
| `list_sessions` | `sessionId` optional, `limit` optional | Addressable Sessions with exact ids, titles, working directory, creation time, and liveness. Pass `sessionId` to check one id without reading the whole catalog. |
| `send_session_message` | `sessionId`, `message` | Deliver one message to a target Session's main agent. |

## Configuration

| Key | Default | Meaning |
| --- | --- | --- |
| `maxMessageBytes` | `65536` | Largest UTF-8 message one call may deliver. |
| `maxTargets` | `50` | Most rows one catalog read returns. |

## Install

Build first — the package ships `lib/` and nothing compiles it at install time:

```sh
pnpm install
pnpm build
```

Then add the package from the Plugins page, by this directory's absolute path, or from a shell:

```sh
dsh plugin --profile <profile> add "<absolute path to this directory>"
```

Installing it adds one profile layer:

| Entry | Package |
| --- | --- |
| `session-messenger` | this package |

Repository and npm installation need a published build; a local path installation is a link, so it points at this directory and stops working if the directory moves.

## Behavior

A target that this Host already runs receives the message through the Agent inbox, at the nearest step boundary when a turn is executing. A target that is stored but not loaded is resumed first — with the Agent preset its header records when a preset registry is mounted — and then receives the message. Delivery is durable: the call reports failure unless Session persistence acknowledges the message.

Messages reach main-agent Sessions only. A delegated child Session is rejected, because its parent already owns that conversation's input path.

## Model experience

A tool argument is named exactly as the result field the caller reads it from: `list_sessions` reports `sessionId`, and `send_session_message` takes `sessionId`. An earlier revision took `session_id`, which read as a return field and sent the model looking for the real name in the binding source — nine round trips to deliver one message. Each description also states its argument names, so a PTC-mode model that sees only a generated SDK reads them from the tool text rather than introspecting the transport.

The model sees two tools. `list_sessions` answers with JSON rows; `send_session_message` answers with the delivered message id, the target id, and whether the target is now running. The receiving model sees a user-role message whose first block is `Message from session <id>:`, followed by the caller's text, so it can reply through the same tool with that id.

Addressing is id-only on purpose: a Session title is display text that may repeat, while the id is unique. `list_sessions` returns both — `title` so a person or model can recognize a Session, `sessionId` as the only value `send_session_message` accepts — and the receiving model learns the sender's id rather than its title.

The title comes from the `title` projection key, read from the live registry for an attached Session and from the durable projection cache for one this Host has not loaded. Neither read folds a Session log: folding costs the whole log per row, and a catalog read answers while the model is waiting. A Session that no projection has titled yet carries no `title` field, so its row is addressable by id alone — a Session persisted before the projection cache was composed stays untitled until it is opened once and checkpointed.

## Known Limitations and Deferred Work

- One-way per call. There is no reply routing: the receiver answers by calling the same tool with the sender's id.
- A resumed target stays live in this Host for the life of the plugin; nothing returns it to an unloaded state.
- The catalog reads stored Session headers, so it lists Sessions this Host has not loaded; a Session that was never persisted is invisible until it is.
- No delivery acknowledgement from the receiving model: the receipt reports that the message entered the target inbox, not that a turn answered it.
- A title is a hint, not an address. Rows can carry the same title, and a Session no projection has titled carries none, so a target is chosen by id whatever the title reads.
