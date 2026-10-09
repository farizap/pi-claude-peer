# pi-claude-peer

A [pi coding agent](https://github.com/earendil-works/pi-coding-agent) extension
that lets a **pi** session join Claude Code's peer-messaging system as a
first-class peer — discoverable by `ListAgents`, reachable by `SendMessage`,
able to reply.

## Install

```bash
pi install git:github.com/farizap/pi-claude-peer
```

## Enable

**On by default** once installed. The extension activates when at least one
other live session is registered in `~/.claude/sessions` — i.e. a real Claude
or pi teammate to talk to. On a lone pi (no peers) it stays inert, so nothing
is written or opened needlessly.

| Env | Effect |
|---|---|
| *(unset)* | auto-on when peers exist |
| `PI_CLAUDE_PEER=0` | fully off |
| `PI_PEER_NAME=<name>` | override the peer name (default `<cwd>-pi-<pid36>`) |

```bash
pi                                # peers automatically if teammates are up
PI_PEER_NAME=myname pi            # explicit peer name
PI_CLAUDE_PEER=0 pi               # disabled
```

### Always-on opt-out (optional)

If you want it *always* active — even as the first/only session — export the
flag in your shell rc instead of relying on the presence gate:

```bash
# ~/.zshrc or ~/.bashrc
export PI_PEER_NAME=myname        # optional stable name
# PI_CLAUDE_PEER is opt-out; no need to set it to enable
```

To force it on even with no peers around, set `PI_CLAUDE_PEER=1` explicitly
(the presence check is skipped when you opt in explicitly — see below).

---
## #-mention (peer send)

Type **`#<name>`** in the editor — autocompletes to a live peer and inserts
`#<name> `. A message **starting with** `#<peer> <text>` is intercepted and
routed straight to that peer's mailbox (no model turn). `#` is the mention
prefix — `@` stays file-attach. Mid-sentence `#x` doesn't send; only a leading
token does. The peer name shows in the footer (`◈ <name>`) and a live roster
sits under the chat input.

## What it does

1. Writes `~/.claude/sessions/<pid>.json` + `<pid>.<hash>.key` in Claude's exact
   registration format (this is what `ListAgents` scans).
2. Opens a UDS listener at `/tmp/cc-socks/<pid>.sock`. Inbound `user` frames are
   injected into the pi session as a `steer` message (`customType: peer_message`).
3. Registers two tools:
   - `list_peers` — live Claude peer sessions (scans `~/.claude/sessions/*.json`,
     filters to alive pids).
   - `send_peer_message` `{to, message}` — connects to the peer's
     `messagingSocketPath`, writes `auth` + `user` frames. Verified delivered to
     Claude's mailbox.

## The discovery gate (hard-won)

`procStart` **must** be the process's real start time formatted by
`TZ=UTC ps -o lstart=`. Claude's `isSaneEpochMs` rejects any other format/timezone
and silently drops the peer from `ListAgents`. No binary-name check — a `pi`
process passes.

## Wire format

Outbound / inbound `user` frame:

```json
{"msgV":1,"msg_id":"<uuid>","type":"user",
 "message":{"role":"user","content":"<cross-session-message from=\"uds:<sock>\" from-name=\"<name>\" from-mode=\"prompting\">\n...\n</cross-session-message>"},
 "priority":"next","from":"uds:<sender-sock>"}
```

## The `.key` filename

`<pid>.<sha256(messagingSocketPath)>.key` — the hex suffix is the SHA-256 of the
socket path string (e.g. `sha256("/tmp/cc-socks/12345.sock")`). Claude's key
resolver (`whs`) locates the token by hashing the socket path, so a random suffix
makes the peer unreachable even though `ListAgents` shows it.

## Inbox behaviour (the `success:false` trap)

The listener must be a **bare accept** inbox: `net.createServer(conn => ...)` with
no options, read frames, and **never write back or proactively `conn.end()`**.
Claude's `SendMessage` resolves on the write landing — it does NOT wait for an
ack. Responding `auth_ok`, returning a receipt on the inbound conn, or closing the
sender's bare vet-probe conn all get treated as a protocol error and the send
reports `success:false` even though the message was delivered. Replies to the
sender go through its own `from` socket, not the inbound conn.
