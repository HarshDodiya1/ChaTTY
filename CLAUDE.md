# CLAUDE.md

Guidance for Claude Code when working in this repository.

## Project

ChaTTY is a P2P LAN terminal chat app: TypeScript on **Bun** (runtime, `bun:sqlite`, test PTYs), **Ink 7** (React) for the TUI, `bonjour-service` for mDNS. There's no server. Binary name: `chatty`. Data dir: `~/.chatty-v2` (override with `--data-dir`).

The original Rust implementation was replaced by this rewrite; it only exists in git history. The wire protocol is not compatible with it.

## Commands

```bash
bun install
bun start -- --name alice                 # run from source
bun run dev                               # watch mode
bun run check                             # biome check + tsc (what CI runs)
bun run lint:fix                          # biome autofix
bun run smoke [path/to/binary]            # E2E: two instances in PTYs must connect, chat, exit 0
bun run build                             # host binary → dist/<os>-<arch>/chatty (+ tarball, sha256)
bun scripts/build.ts --version 2.1.0 darwin-arm64 linux-x64   # specific targets
bun scripts/formula.ts --version 2.1.0    # print Homebrew formula from dist/*.sha256
```

Two local instances:

```bash
bun start -- --name alice --port 7878 --data-dir /tmp/chatty-alice --no-mdns
bun start -- --name bob --port 7879 --data-dir /tmp/chatty-bob --no-mdns --peer 127.0.0.1:7878
```

Logs: `<data-dir>/chatty.log` (`--debug` for verbose). Nothing is ever printed to stdout while the TUI runs.

## Testing policy

Don't add unit-test files. Verify changes by **running the app**: `bun run smoke`, or drive real instances in PTYs (`Bun.spawn` with the `terminal` option, with `@xterm/headless` to read the screen) and inspect screens, `chatty.db` and logs.

## Architecture

- `src/core/engine.ts` — `ChatEngine`, the headless core. It owns the Transport, Discovery and Store; handles every peer message; exposes view models (`contacts()`, `groups()`, `messages()`, `conversationInfo()`, `transfers()`) and commands (`sendText`, `createGroup`, `sendFile`, …). It emits `change` (coalesced once per tick), `notice`, `incoming` and `file_offer`.
- `src/core/transport.ts` — TCP listener plus dial targets with backoff; keeps **one live connection per peer**. When both peers dial each other, the connection initiated by the smaller user id wins on both sides. It also sends keepalive pings and times out dead peers.
- `src/core/connection.ts` — per-socket handshake (`hello` / `hello_ack` in plaintext: Ed25519-signed ephemeral X25519 key). After the handshake every frame is sealed with AES-256-GCM using per-direction counter nonces.
- `src/core/protocol.ts` — framing `[u32 BE len][u8 kind][payload]` with JSON payloads, plus a validator for each message type (`parsePeerMessage`).
- `src/core/discovery.ts` — mDNS `_chatty._tcp`; the TXT record carries the user id.
- `src/store/db.ts` — `bun:sqlite` schema and queries. Tables: users, conversations, participants, messages, deliveries (one row per recipient for receipts), transfers. Timestamps are epoch ms.
- `src/ui/App.tsx` — all UI state and keyboard handling. **Input and focus are stored in refs** (`inputRef`, `focusRef`) because keys can arrive faster than React re-renders. Keep handlers reading those refs.
- `src/ui/chatLines.ts` — lays messages out as pre-wrapped styled lines, which gives exact scrolling. `ChatView` renders a slice of them.

### Key rules

- Direct conversation id: `dm:<sortedIdA>:<sortedIdB>`. Groups: `grp:<uuid>`, with last-writer-wins state by `version`. The full state is re-sent on every `peer_up`.
- Delivery is at-least-once: messages stay undelivered until the recipient acks them. They're retried on `peer_up` and every 15 s. The receiver dedupes with `INSERT OR IGNORE`.
- Identity keys are trusted on first use (TOFU). A changed key sets `key_changed` and posts a system warning.

## CI/CD

- `.github/workflows/ci.yml`: lint, typecheck, then smoke tests (source and compiled binary) on Ubuntu and macOS.
- `.github/workflows/release.yml`: triggered by a `v*.*.*` tag.
  1. Build 4 targets. macOS builds run on macOS so they get an ad-hoc codesign; x64 uses Bun's baseline build.
  2. Publish a GitHub release.
  3. Push `Formula/chatty.rb` to `HarshDodiya1/homebrew-tap`, using the `HOMEBREW_TAP_DEPLOY_KEY` secret (an SSH deploy key scoped to the tap).
  4. Run `brew install` + `brew test`.

## Commits

Never add AI/Claude attribution to commits or PRs.
