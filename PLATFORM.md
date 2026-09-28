# ChaTTY — Platform Documentation

1. [Platform Summary](#platform-summary)
2. [Feature List](#feature-list)
3. [User Manual](#user-manual)

---

## Platform Summary

ChaTTY is peer-to-peer chat that runs in your terminal. It needs no server, no internet connection and no account. Machines on the same network talk directly to each other, and everything is end-to-end encrypted.

### Technology Stack

| Layer | Technology |
|---|---|
| Language / runtime | TypeScript on Bun |
| Terminal UI | Ink 7 (React 19) |
| Peer discovery | mDNS via `bonjour-service` (`_chatty._tcp.local.`) |
| Transport | TCP (default port 7878) |
| Wire protocol | JSON payloads in `[u32 length][u8 kind]` frames |
| Persistence | SQLite via `bun:sqlite` |
| Encryption | Ed25519 identity, X25519 per-connection key exchange, HKDF-SHA256, AES-256-GCM |
| File integrity | SHA-256 |
| Distribution | Standalone binaries (`bun build --compile`), GitHub Releases, Homebrew tap |

### Architecture

```
┌──────────────────────── Terminal UI (Ink) ─────────────────────────┐
│ Header · Sidebar (DMs / groups) · Chat view · Command palette ·    │
│ Composer · Modals (help, search, files, peers, verify) · Toasts    │
└───────────────────────────────┬────────────────────────────────────┘
                                │ view models + commands / change events
                    ┌───────────┴───────────┐
                    │      ChatEngine       │  receipts, groups, files,
                    │  (headless, testable) │  presence, typing, retry
                    └──┬─────────┬───────┬──┘
                       │         │       │
               Transport    Discovery   Store
            (TCP, dedupe,    (mDNS)    (SQLite)
          keepalive, redial)
                       │
                  Connection  ← handshake + AES-GCM framing per peer
```

### How It Works

1. **Startup:**
   - Reads or creates `~/.chatty-v2/config.json` (username, user id, port).
   - Loads or creates the Ed25519 identity key (`identity.key`, mode 600).
   - Opens `chatty.db` and starts listening on TCP.
2. **Discovery:** ChaTTY does three things, so peers usually connect without any setup:
   - advertises itself over mDNS and browses for other instances;
   - redials peers it has talked to before;
   - dials anyone given via `--peer` or `/connect`.
   
   Connected peers also share each other's addresses, so every member of a group ends up connected to every other.
3. **Handshake:**
   - Each connection starts with `hello` / `hello_ack`. Each one carries the sender's identity key and a fresh X25519 key, signed with the identity key.
   - Both sides derive two AES-256-GCM keys, one per direction.
   - Every later frame is encrypted with a counter nonce, so a tampered, replayed or reordered frame is rejected.
4. **Messaging:**
   - Messages are saved locally first, then sent.
   - They stay "sent" (✓) until the recipient acknowledges them ("delivered", ✓✓), and turn "read" (blue ✓✓) once the recipient opens the conversation.
   - Unacknowledged messages are resent when the peer reconnects, and every 15 seconds.
5. **Shutdown:** ChaTTY sends a `goodbye` to all peers, marks everyone offline and restores the terminal.

### Data Storage (`~/.chatty-v2/`)

| File | Purpose |
|---|---|
| `config.json` | User id, username, display name, port, settings |
| `chatty.db` | Users, conversations, messages, receipts, file transfers |
| `identity.key` | Ed25519 private key (mode 600) |
| `chatty.log` | Log file (`--debug` for verbose) |
| `downloads/` | Files received from peers |

---

## Feature List

- **Messaging:** real-time direct chats. Offline messages are queued and delivered on reconnect. Unread badges; unread count in the terminal title.
- **Receipts & presence:** ✓ sent, ✓✓ delivered, blue ✓✓ read. Online / away / offline with "last seen", and typing indicators.
- **Groups:** create (optionally with members), invite, leave, get re-invited. Membership is synced to every member, and system messages record changes.
- **Files:** `/file` with path autocompletion, and an accept/decline popup on the receiving side. Live progress bars. SHA-256 is verified, and corrupt files are deleted. Received files never overwrite existing ones (`_1`, `_2`…). Maximum size 1 GiB.
- **Security:**
  - End-to-end encryption on every connection.
  - Keys are trusted the first time they're seen, with a warning if one changes later.
  - `/verify` safety numbers.
  - `/info` shows your key fingerprint.
- **Search & history:** `/search` with jump-to-message, `/history n`, `/clear` (the view only), `/export` to a text file.
- **Terminal experience:**
  - command palette with argument completion (users, files, transfers)
  - input history, multi-line messages, paste support
  - highlighted links, `code` and @mentions
  - day separators and message grouping
  - toasts and desktop notifications
  - layout that adapts from wide screens down to a single-pane compact mode

---

## User Manual

### Installation

```bash
brew install HarshDodiya1/tap/chatty       # macOS / Linux
```

Or download a binary from GitHub Releases, or run from source with `bun install && bun start`.

### Command-Line Options

```
chatty [options]
  --name <name>        Set your username (saved for next time)
  --port <port>        Listen port (default 7878)
  --peer <host:port>   Connect to a peer directly (repeatable)
  --data-dir <dir>     Data directory (default ~/.chatty-v2)
  --no-mdns            Disable LAN auto-discovery
  --auto-accept        Accept incoming files automatically
  --debug              Verbose logging
  -v, --version        Print version
  -h, --help           Show help
```

### Keyboard

| Key | Action |
|---|---|
| `↑` `↓` / `j` `k` | Move between chats (sidebar) |
| `Enter` / `Tab` | Open the chat and focus the message box |
| `Esc` | Back to sidebar / close popups / dismiss suggestions |
| `Ctrl+N` / `Ctrl+P` | Next / previous chat from anywhere |
| `PgUp` / `PgDn`, `Shift+↑↓` | Scroll messages |
| `End` | Jump to newest message |
| `↑` / `↓` (empty input) | Recall sent messages |
| `Alt+Enter` | New line |
| `Ctrl+W` / `Ctrl+U` | Delete word / line |
| `Ctrl+F` / `Ctrl+T` | Search / file transfers |
| `?` (sidebar) | Help |
| `q` (sidebar) / `Ctrl+C` | Quit |

### Slash Commands

| Command | Description |
|---|---|
| `/help` | Commands and shortcuts |
| `/info` | Your name, addresses, port, fingerprint |
| `/nick <name>` | Change display name |
| `/status <online\|away>` | Set availability |
| `/connect <host[:port]>` | Connect to a peer manually |
| `/peers` | List known peers |
| `/notify <on\|off>` | Desktop notifications |
| `/msg <user>` | Open a direct chat |
| `/search <text>` | Search this conversation |
| `/history [n]` | Load the last n messages |
| `/clear` | Clear the view (history kept) |
| `/export` | Save conversation to a text file |
| `/group create <name> [users…]` | Create a group |
| `/group invite <user>` | Add a member |
| `/group members` / `/group list` | Show members / your groups |
| `/group leave` | Leave the group |
| `/file <path>` | Send a file |
| `/files` | Transfers panel (a accept · d decline · c cancel) |
| `/accept` / `/decline` / `/cancel [file]` | Manage transfers |
| `/autoaccept <on\|off>` | Auto-accept incoming files |
| `/verify [user]` | Compare safety numbers |
| `/quit` | Exit |

Start a message with `//` to send text that begins with `/`.

### Troubleshooting

- **Peers don't appear:**
  - Both machines must be on the same subnet, with UDP 5353 (mDNS) and your TCP port allowed.
  - Many Wi-Fi networks isolate clients. Connect directly with `--peer <ip>:7878` from **one** side; that's enough, because replies travel back on the same connection.
  - Run `/info` to see your address.
- **"Port … is already in use":** another instance is running; use `--port`.
- **Security key changed:** the peer reinstalled, or someone is intercepting. Run `/verify <user>` and compare the numbers in person.
- **Logs:** `~/.chatty-v2/chatty.log`; start with `--debug` for more detail.

### Uninstall

```bash
brew uninstall chatty
rm -rf ~/.chatty-v2        # deletes history, keys and config
```
