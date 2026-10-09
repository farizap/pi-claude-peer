/**
 * claude-peer — join Claude Code's peer-messaging system as a first-class peer.
 *
 * Registers this pi session in ~/.claude/sessions/<pid>.json (Claude's own
 * discovery format) and opens a UDS listener at /tmp/cc-socks/<pid>.sock so
 * Claude Code teammates can SendMessage this session. Inbound peer frames are
 * injected into pi as steer messages.
 *
 * Outbound: the `send_peer_message` tool connects to a peer's socket and writes
 * a `user` frame — proven to reach Claude's mailbox.
 *
 * Discovery gate (empirically verified): the `procStart` field must be the
 * process's real start time formatted by `ps -o lstart=` in UTC — Claude's
 * `isSaneEpochMs` check rejects anything else and the peer is silently dropped
 * from ListAgents.
 *
 * Enabled by default once installed — activates whenever at least one other
 * live session is registered in ~/.claude/sessions (a real peer to talk to).
 * Disable with:          PI_CLAUDE_PEER=0
 * Optional name override: PI_PEER_NAME=<name>
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "typebox";
import net from "node:net";
import fs from "node:fs";
import os from "node:os";
import crypto from "node:crypto";
import { execSync, spawn } from "node:child_process";
import path from "node:path";

const FLAG = "PI_CLAUDE_PEER";
const NAME_FLAG = "PI_PEER_NAME";
const SESSIONS_DIR = path.join(os.homedir(), ".claude", "sessions");
const SOCK_DIR = "/tmp/cc-socks";
const PEER_FEATURES = ["notify_idle", "reply_across_default_dirs", "artifact_yield"];
const CLAUDE_VERSION = "2.1.293";

interface PeerRecord {
  pid: number;
  sessionId: string;
  cwd: string;
  name?: string;
  status?: string;
  kind?: string;
  messagingSocketPath?: string;
  peerProtocol?: number;
}

interface Bridge {
  sockPath: string;
  sessionFile: string;
  keyFile: string;
  server: net.Server;
  sessionId: string;
  name: string;
}

function enabled(): boolean {
  // Enabled by default once installed. PI_CLAUDE_PEER=0 disables.
  // To keep a solo pi from littering ~/.claude/sessions + opening a socket when
  // no Claude is around, we ALSO require at least one live peer already
  // registered (a real teammate/session to talk to). That means the feature
  // activates automatically inside a multi-agent herdr/team setup and stays
  // inert on a lone pi.
  const v = process.env[FLAG];
  if (v === "0" || v === "false") return false;
  // Explicit opt-in always enables (skips the peer-presence gate).
  if (v === "1" || v === "true") return true;
  // Default: on, but only when a real peer exists to talk to.
  return claudePeersPresent();
}

/** True iff at least one other live session is registered in ~/.claude/sessions. */
function claudePeersPresent(): boolean {
  try {
    for (const f of fs.readdirSync(SESSIONS_DIR)) {
      if (!f.endsWith(".json")) continue;
      const pid = parseInt(f, 10);
      if (!Number.isFinite(pid) || pid === process.pid) continue;
      try {
        process.kill(pid, 0); // alive
        return true;
      } catch {
        /* dead */
      }
    }
  } catch {
    /* no sessions dir */
  }
  return false;
}

/** Process start time in the exact format Claude expects: `ps -o lstart=` in UTC. */
function procStartUtc(pid: number): string {
  return execSync(`TZ=UTC ps -o lstart= -p ${pid}`).toString().trim();
}

function defaultName(cwd: string): string {
  const base = path.basename(cwd) || "pi";
  return `${base}-pi-${process.pid.toString(36)}`;
}

function readPeers(): PeerRecord[] {
  const out: PeerRecord[] = [];
  let entries: string[] = [];
  try {
    entries = fs.readdirSync(SESSIONS_DIR).filter((f) => f.endsWith(".json"));
  } catch {
    return out;
  }
  for (const f of entries) {
    try {
      const rec = JSON.parse(fs.readFileSync(path.join(SESSIONS_DIR, f), "utf8"));
      if (typeof rec.pid !== "number") continue;
      try {
        process.kill(rec.pid, 0); // alive check
      } catch {
        continue;
      }
      out.push(rec);
    } catch {
      /* malformed record — skip */
    }
  }
  return out;
}

function peerTokenFor(pid: number): string | undefined {
  try {
    const kf = fs
      .readdirSync(SESSIONS_DIR)
      .find((f) => f.startsWith(`${pid}.`) && f.endsWith(".key"));
    if (!kf) return undefined;
    return JSON.parse(fs.readFileSync(path.join(SESSIONS_DIR, kf), "utf8")).peerToken;
  } catch {
    return undefined;
  }
}

/** Send a peer message to a Claude session's socket. Resolves on write or rejects on error/timeout. */
function sendToPeer(rec: PeerRecord, content: string, fromName: string, selfSock: string): Promise<void> {
  return new Promise((resolve, reject) => {
    if (!rec.messagingSocketPath) return reject(new Error("peer has no socket"));
    const token = peerTokenFor(rec.pid);
    const sock = net.connect(rec.messagingSocketPath);
    const timer = setTimeout(() => {
      sock.destroy();
      reject(new Error("connect/send timeout"));
    }, 5000);
    sock.on("connect", () => {
      // auth frame (best-effort; ignored if unknown)
      if (token) sock.write(JSON.stringify({ type: "auth", token }) + "\n");
      const frame = {
        msgV: 1,
        msg_id: crypto.randomUUID(),
        type: "user",
        message: {
          role: "user",
          content:
            `<cross-session-message from="uds:${selfSock}" from-name="${fromName}" from-mode="prompting">\n` +
            content +
            `\n</cross-session-message>`,
        },
        priority: "next",
        from: `uds:${selfSock}`,
      };
      sock.write(JSON.stringify(frame) + "\n", () => {
        clearTimeout(timer);
        sock.end();
        resolve();
      });
    });
    sock.on("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
  });
}

export default function claudePeerExtension(pi: ExtensionAPI) {
  let bridge: Bridge | undefined;

  let starting = false;
  let lastCtx: any;
  function startBridge(ctx: any) {
    lastCtx = ctx;
    if (!enabled() || bridge || starting) return;
    starting = true;
    const pid = process.pid;
    const sockPath = path.join(SOCK_DIR, `${pid}.sock`);
    fs.mkdirSync(SOCK_DIR, { recursive: true });
    try {
      fs.unlinkSync(sockPath);
    } catch {}
    const sessionId = crypto.randomUUID();
    const peerToken = crypto.randomBytes(16).toString("hex");
    const now = Date.now();
    const cwd: string = ctx?.cwd ?? process.cwd();
    const name = process.env[NAME_FLAG] || defaultName(cwd);

    // Match the bare-inbox behaviour that Claude's SendMessage accepts: accept the
    // conn, read frames, and NEVER write back or proactively close. Claude's vet
    // does a bare connect-then-close probe; replying or closing it ourselves makes
    // the sender treat the inbox as a protocol error and report success:false.
    const server = net.createServer((conn) => {
      let buf = Buffer.alloc(0);
      conn.on("data", (d) => {
        buf = Buffer.concat([buf, d]);
        let i;
        while ((i = buf.indexOf(0x0a)) >= 0) {
          const line = buf.slice(0, i).toString();
          buf = buf.slice(i + 1);
          if (!line.trim()) continue;
          let msg: any;
          try {
            msg = JSON.parse(line);
          } catch {
            continue;
          }
          handlePeerFrame(msg, conn);
        }
      });
      conn.on("error", () => {});
      conn.on("close", () => {});
    });
    server.listen(sockPath);

    function handlePeerFrame(m: any, conn: net.Socket) {
      if (m?.type === "user" && m?.message?.content) {
        // Pure inbox accept (a bare inbox gets success:true with no reply bytes).
        // Nothing is written back on the inbound conn — the sender resolves on write.
        const raw = String(m.message.content);
        const fromMatch = raw.match(/from-name="([^"]+)"/);
        const from = m["from-name"] ?? fromMatch?.[1] ?? m.from ?? "peer";
        const body = raw
          .replace(/^<cross-session-message[^>]*>\n/, "")
          .replace(/\n<\/cross-session-message>$/, "");
        pi.sendMessage(
          {
            customType: "peer_message",
            content: `[peer:${from}] ${body}`,
            display: true,
            details: { from, msg_id: m.msg_id, raw },
          },
          { triggerTurn: true, deliverAs: "steer" },
        );
      }
      // `auth` frames are fire-and-forget — no response needed.
    }

    // Register the session record Claude scans.
    const sessionFile = path.join(SESSIONS_DIR, `${pid}.json`);
    // Claude derives the key filename as <pid>.<sha256(socketPath)>.key — a random
    // suffix makes the token unfindable and SendMessage refuses the "unvouched pipe".
    const keyHash = crypto.createHash("sha256").update(sockPath).digest("hex");
    const keyFile = path.join(SESSIONS_DIR, `${pid}.${keyHash}.key`);
    const procStart = procStartUtc(pid);
    const record = {
      pid,
      sessionId,
      cwd,
      startedAt: now,
      procStart,
      version: CLAUDE_VERSION,
      peerProtocol: 1,
      peerFeatures: PEER_FEATURES,
      kind: "interactive",
      entrypoint: "cli",
      pidDomain: process.platform === "darwin" ? "darwin" : "linux",
      messagingSocketPath: sockPath,
      name,
      nameSource: "user",
      nameSince: now,
      updatedAt: now,
      status: "idle",
      statusUpdatedAt: now,
    };
    try {
      fs.mkdirSync(SESSIONS_DIR, { recursive: true });
      fs.writeFileSync(sessionFile, JSON.stringify(record));
      fs.writeFileSync(keyFile, JSON.stringify({ peerToken, procStart, pidDomain: record.pidDomain }));
    } catch (e) {
      try {
        server.close();
        fs.unlinkSync(sockPath);
      } catch {}
      starting = false;
      ctx?.ui?.notify?.(`claude-peer: registration failed: ${e}`, "error");
      return;
    }

    bridge = { sockPath, sessionFile, keyFile, server, sessionId, name };
    starting = false;
    // Show the teammate's peer name in the footer so you can tell which peer
    // this session is. Status key is stable; clears on shutdown.
    ctx?.ui?.setStatus?.("claude-peer", `◈ ${name}`);
    ctx?.ui?.setTitle?.(`${name} · pi`);
    ctx?.ui?.notify?.(`claude-peer: registered as "${name}" (pid ${pid})`, "info");
    startRosterWidget(ctx);
  }

  // Live teammate roster above the editor — "teammates: name(!!) name2 · pid"
  // on one line, refreshed every 3s. Shows the lead/any peer who is around.
  let rosterTimer: ReturnType<typeof setInterval> | undefined;
  function startRosterWidget(ctx: any) {
    const ui = ctx?.ui;
    if (!ui?.setWidget || rosterTimer) return;
    const render = () => {
      if (!bridge) return;
      const peers = readPeers().filter((p) => p.sessionId !== bridge.sessionId && p.name);
      // Fit one line to a sane width: join short names, stop at ~60 chars,
      // append `+N more`. Never wraps.
      const names = peers.map((p) => String(p.name).replace(/\s+/g, "-"));
      let line = "◇";
      let used = 2;
      let i = 0;
      for (; i < names.length; i++) {
        const n = names[i].slice(0, 20);
        const add = (i === 0 ? " " : " ") + n;
        if (used + add.length > 58) break;
        line += add;
        used += add.length;
      }
      const more = names.length - i;
      if (more > 0) line += ` +${more}`;
      if (names.length === 0) line = "◇ no teammates";
      ui.setWidget("peer-roster", [line], { placement: "belowEditor" });
    };
    render();
    rosterTimer = setInterval(render, 3000);
  }

  function stopBridge() {
    if (!bridge) return;
    try {
      bridge.server.close();
    } catch {}
    // Clear the footer status so a stale name doesn't linger on shutdown.
    try {
      lastCtx?.ui?.setStatus?.("claude-peer", undefined);
    } catch {}
    if (rosterTimer) {
      clearInterval(rosterTimer);
      rosterTimer = undefined;
    }
    try {
      lastCtx?.ui?.setWidget?.("peer-roster", undefined);
    } catch {}
    for (const f of [bridge.sessionFile, bridge.keyFile, bridge.sockPath]) {
      try {
        fs.unlinkSync(f);
      } catch {}
    }
    bridge = undefined;
  }

  // Route `#<peer> <text>` — a message whose FIRST token is a registered peer
  // name goes straight to that peer's mailbox instead of the model. `#` is the
  // mention prefix (distinct from `@` file-attach).
  pi.on("input", async (e) => {
    if (!enabled() || !bridge) return undefined;
    if ((e as any).type !== "input") return undefined;
    const text = (e as any).text as string | undefined;
    if (!text || !text.startsWith("#")) return undefined;
    const m = /^#([A-Za-z0-9_-]+)(?:\s+(.*))?$/s.exec(text);
    if (!m) return undefined;
    const target = readPeers().find(
      (p) => p.sessionId !== bridge.sessionId && p.name && p.name.toLowerCase() === m[1].toLowerCase(),
    );
    if (!target) return undefined; // not a peer — let pi handle it (file attach etc.)
    const body = (m[2] ?? "").trim();
    if (!body) {
      // bare #peer — just show the peer exists, no send
      return { action: "handled" } as any;
    }
    try {
      await sendToPeer(target, body, bridge.name, bridge.sockPath);
      // confirm in the transcript without spending a model turn
      pi.sendMessage(
        { customType: "peer_send", content: `→ ${target.name}: ${body}`, display: true },
        { triggerTurn: false },
      );
      return { action: "handled" } as any;
    } catch (err) {
      pi.sendMessage(
        { customType: "peer_send", content: `✗ send to ${target.name} failed: ${(err as Error).message}`, display: true },
        { triggerTurn: false },
      );
      return { action: "handled" } as any;
    }
  });

  pi.on("session_start", (_e, ctx) => startBridge(ctx));
  pi.on("session_shutdown", () => stopBridge());
  process.on("exit", stopBridge);

  // #-mention peers: wrap the built-in autocomplete so typing `#<name>` in
  // the editor completes to a live Claude peer. `@` stays file-attach.
  // Registers once (guarded) on session start; the provider reads fresh peers.
  let peerAutocompleteRegistered = false;
  pi.on("session_start", (_e, ctx) => {
    if (!enabled() || peerAutocompleteRegistered) return;
    const ui = (ctx as any)?.ui;
    if (!ui?.addAutocompleteProvider) return;
    peerAutocompleteRegistered = true;
    ui.addAutocompleteProvider((current: any) => ({
      ...current,
      async getSuggestions(lines: string[], cursorLine: number, cursorCol: number, options: any) {
        const currentLine = lines[cursorLine] || "";
        const textBeforeCursor = currentLine.slice(0, cursorCol);
        // Match a `#` token the cursor is at the end of — peers only;
        // `@` stays file-attach.
        const atMatch = /(^|\s)#([A-Za-z0-9_-]*)$/.exec(textBeforeCursor);
        if (!atMatch) return current.getSuggestions(lines, cursorLine, cursorCol, options);
        const partial = atMatch[2].toLowerCase();
        const peers = readPeers().filter((p) => p.sessionId !== bridge?.sessionId && p.name);
        const items = peers
          .filter((p) => (p.name ?? "").toLowerCase().startsWith(partial))
          .map((p) => ({
            // value replaces the whole #token prefix — keep the '#' so the
            // inserted text stays '#name' for the input router to catch.
            value: `#${p.name}`,
            label: `#${p.name}`,
            description: `${p.kind ?? "peer"} · ${p.status ?? "?"} · pid ${p.pid}`,
          }));
        if (items.length === 0) return current.getSuggestions(lines, cursorLine, cursorCol, options);
        // prefix is the whole #token so applyCompletion replaces it correctly.
        const prefix = "#" + atMatch[2];
        return { items, prefix };
      },
      applyCompletion(lines: string[], cursorLine: number, cursorCol: number, item: any, prefix: string) {
        return current.applyCompletion(lines, cursorLine, cursorCol, item, prefix);
      },
    }));
  });

  pi.registerTool({
    name: "send_peer_message",
    label: "Send Peer Message",
    description:
      "Send a message to a Claude Code peer session (a teammate listed by list_peers). " +
      "Delivers into the peer's mailbox; the peer replies via its own send mechanism. " +
      `Only available when ${FLAG}=1.`,
    promptSnippet: "Send a peer message to a Claude session (teammate).",
    parameters: Type.Object({
      to: Type.String({ description: "Peer name or [ref] e.g. 'reviewer' or '98ca05'" }),
      message: Type.String({ description: "Message content" }),
    }),
    async execute(_id, params: { to: string; message: string }) {
      if (!enabled() || !bridge) {
        return { content: [{ type: "text", text: `claude-peer disabled — set ${FLAG}=1` }] };
      }
      const peers = readPeers();
      const target = peers.find(
        (p) => p.name === params.to || p.name?.startsWith(params.to) || p.sessionId.startsWith(params.to) || String(p.pid) === params.to,
      );
      if (!target) {
        return {
          content: [{ type: "text", text: `No peer '${params.to}'. Known: ${peers.map((p) => p.name).join(", ")}` }],
        };
      }
      try {
        await sendToPeer(target, params.message, bridge.name, bridge.sockPath);
        return { content: [{ type: "text", text: `Sent to ${target.name ?? target.pid}.` }] };
      } catch (e) {
        return { content: [{ type: "text", text: `Send failed: ${(e as Error).message}` }] };
      }
    },
  });

  // Spawn a NEW pi process that self-registers as a claude peer. With `prompt`,
  // runs headless (`pi -p`) — fires the task then exits. A standing (no-prompt)
  // spawn exits immediately because a detached process has no TTY — interactive
  // teammates must be launched in a real terminal pane instead.
  pi.registerTool({
    name: "spawn_peer_teammate",
    label: "Spawn Peer Teammate",
    description:
      "Spawn a new pi session that registers itself as a Claude peer (visible to claude's " +
      "ListAgents, reachable by SendMessage, and sees claude via list_peers). " +
      "`name` sets its peer name. Requires `prompt` — the task to run headless; the child " +
      "exits when done. For a standing interactive teammate, launch `PI_CLAUDE_PEER=1 pi` " +
      "in a real terminal/pane instead (a detached spawn has no TTY and exits at once).",
    promptSnippet: "Spawn a headless pi peer teammate to run a task.",
    parameters: Type.Object({
      name: Type.String({ description: "Peer name, e.g. 'scout-2'" }),
      prompt: Type.String({ description: "One-shot task to run headless" }),
      model: Type.Optional(Type.String({ description: "Model id e.g. 'neuralwatt/glm-5.3-flash' or 'claude-bridge/claude-sonnet-5'. Defaults to PI_PEER_MODEL or 'neuralwatt/glm-5.3-flash' — the bare `pi` default (devin swe-2) is currently erroring." })),
    }),
    async execute(_id, params: { name: string; prompt: string; model?: string }) {
      if (!enabled()) return { content: [{ type: "text", text: `claude-peer disabled — set ${FLAG}=1` }] };
      const piBin = process.env.PI_BIN_PATH || "pi"; // resolve `pi` on PATH (argv[1] is bundled cli.js)
      const args: string[] = ["--print", params.prompt];
      const model = params.model ?? process.env.PI_PEER_MODEL ?? "neuralwatt/glm-5.3-flash";
      if (model) args.unshift("--model", model);
      const child = spawn(piBin, args, {
        cwd: process.cwd(),
        env: { ...process.env, [FLAG]: "1", [NAME_FLAG]: params.name },
        detached: true,
        stdio: "ignore",
      });
      child.unref();
      const pid = child.pid;
      const regFile = path.join(SESSIONS_DIR, `${pid}.json`);
      let registered = false;
      for (let i = 0; i < 40 && !registered; i++) {
        if (fs.existsSync(regFile)) registered = true;
        else await new Promise((r) => setTimeout(r, 150));
      }
      return {
        content: [
          {
            type: "text",
            text:
              `Spawned headless pi teammate '${params.name}' (pid ${pid}). ` +
              (registered
                ? "Registered as a claude peer — visible to claude ListAgents while it runs; it exits when the task completes."
                : "Started; peer registration not yet visible."),
          },
        ],
        details: { pid, name: params.name, registered },
      };
    },
  });

  pi.registerTool({
    name: "list_peers",
    label: "List Peers",
    description: `List live Claude Code peer sessions this pi session can message. Requires ${FLAG}=1.`,
    promptSnippet: "List live Claude Code peer sessions.",
    parameters: Type.Object({}),
    async execute() {
      if (!enabled()) return { content: [{ type: "text", text: `claude-peer disabled — set ${FLAG}=1` }] };
      const peers = readPeers().filter((p) => p.sessionId !== bridge?.sessionId);
      const lines = peers.map((p) => `  ${p.name ?? "(unnamed)"} · ${p.kind ?? "?"} · ${p.status ?? "?"} · pid ${p.pid}`);
      return {
        content: [{ type: "text", text: `Peer sessions (${lines.length}):\n${lines.join("\n")}` }],
        details: { peers },
      };
    },
  });
}
