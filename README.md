# ChaTTY

Peer-to-peer chat for your local network, in the terminal. You don't need a server, an account or an internet connection. Messages are end-to-end encrypted.

Built with TypeScript and [Bun](https://bun.sh); the interface is [Ink](https://github.com/vadimdemedes/ink) (React for the terminal).

## Install

```bash
brew install HarshDodiya1/tap/chatty
```

Or download a binary for macOS or Linux (arm64 / x64) from [Releases](https://github.com/HarshDodiya1/ChaTTY/releases), or run from source:

```bash
bun install
bun start -- --name alice
```

## Usage

```bash
chatty --name alice                                # peers on your LAN appear automatically (mDNS)
chatty --name bob --peer 192.168.1.20:7878         # connect by address when Wi-Fi blocks discovery
chatty --name bob --port 7879 --data-dir ~/.chatty-bob --peer 127.0.0.1:7878   # second instance on one machine
```

If the network blocks multicast or isolates clients, connecting in one direction is enough, because replies travel back over the same TCP connection. Type `/help`, or press `?` in the sidebar, for every command and shortcut.

## Features

- **Discovery:** mDNS, `--peer` / `/connect`, reconnection to known peers, and address sharing between peers (so a group forms a full mesh).
- **Messaging:** direct and group chats, sent ✓ / delivered ✓✓ / read ✓✓ (blue), typing indicators. Messages written while a peer is offline are queued and delivered when it reconnects.
- **Groups:** create, invite, leave and re-invite, with membership synced to every member.
- **Files:** accept/decline prompt, 64 KB chunks, live progress, SHA-256 check (a corrupt file is deleted), and no overwriting of existing names (`_1`, `_2`…).
- **Security:** each connection uses an X25519 key exchange and AES-256-GCM with counter nonces (replayed or reordered frames are rejected). Each user has an Ed25519 identity key. A key is trusted the first time it's seen, with a warning if it changes later. `/verify` shows safety numbers to compare.
- **Interface:**
  - command palette with argument completion (user names, file paths, transfers)
  - search, jumping to a result
  - scrollback, input history, multi-line messages (Alt+Enter)
  - toasts, desktop notifications, unread count in the terminal title
  - layout that adapts down to narrow terminals

Data lives in `~/.chatty-v2/` (`config.json`, `chatty.db`, `identity.key` (mode 600), `chatty.log`, `downloads/`). Run with `--debug` for verbose logs.

## Development

```bash
bun run dev          # run with --watch
bun run check        # Biome lint/format check + TypeScript
bun run lint:fix     # auto-fix formatting and imports
bun run smoke        # end-to-end run: two real instances in PTYs chat and quit cleanly
bun run build        # standalone binary for this machine → dist/<os>-<arch>/chatty
bun run build:all    # cross-compile darwin/linux × arm64/x64 + tarballs + sha256
```

## CI/CD

- **`.github/workflows/ci.yml`** runs on every push to `main` and every pull request:
  - Biome lint and format check, then the TypeScript check.
  - On Ubuntu and macOS, the smoke test from source, then a binary compile and the smoke test again on that binary.
- **`.github/workflows/release.yml`** runs when you push a `v*.*.*` tag:
  1. Builds 4 binaries. The macOS ones are built on macOS and get an ad-hoc code signature. The tag's version is compiled into `chatty --version`.
  2. Smoke-tests the binary that matches the build machine.
  3. Publishes a GitHub release with the tarballs and `checksums.txt`.
  4. Renders `Formula/chatty.rb` into [HarshDodiya1/homebrew-tap](https://github.com/HarshDodiya1/homebrew-tap).
  5. Checks that `brew install` and `brew test` work on macOS and Linux.
  
  Tags with a suffix (e.g. `v2.1.0-rc.1`) become pre-releases and don't update Homebrew.

### Releasing

```bash
# optional: bump "version" in package.json to match
git tag v2.1.0 && git push origin v2.1.0
```

One-time setup: the `homebrew-tap` repository must exist, and this repository needs a `HOMEBREW_TAP_TOKEN` Actions secret: a fine-grained token with **Contents: read & write** on `HarshDodiya1/homebrew-tap`.

## Layout

```
src/cli.tsx            arg parsing, bootstrap, Ink render
src/config.ts          config.json load/save
src/core/protocol.ts   frames: [u32 len][u8 kind][payload], message types + validation
src/core/crypto.ts     identity, handshake, sessions, fingerprints
src/core/connection.ts one TCP peer: handshake + sealed framing
src/core/transport.ts  listener, dialing/backoff, dedupe, keepalive
src/core/discovery.ts  mDNS advertise/browse
src/core/engine.ts     headless chat engine (DB updates, receipts, groups, files)
src/store/db.ts        bun:sqlite schema + queries
src/ui/                Ink components, layout, commands
scripts/               build, smoke test, Homebrew formula renderer
```

## License

MIT
