# ChaTTY — Platform Documentation

## Table of Contents

1. [Platform Summary](#platform-summary)
2. [Feature List](#feature-list)
3. [User Manual](#user-manual)

---

## Platform Summary

### What is ChaTTY?

ChaTTY is a peer-to-peer LAN terminal chat application written in Rust. It runs entirely in your terminal, requires no central server, no internet connection, and no account registration. All communication happens directly between machines on the same local network.

### Technology Stack

| Layer | Technology |
|---|---|
| Language | Rust 2021 Edition |
| Terminal UI | ratatui 0.28 + crossterm 0.28 |
| Async runtime | Tokio (full features) |
| Peer discovery | mDNS via mdns-sd (`_ChaTTY._tcp.local.`) |
| Transport | TCP (default port 7878) |
| Wire protocol | bincode with 4-byte big-endian length framing |
| Persistence | SQLite via rusqlite (bundled) |
| Encryption | X25519 Diffie-Hellman key exchange + AES-256-GCM |
| File integrity | SHA-256 checksums via sha2 |
| Configuration | TOML via the `toml` crate |

### Architecture Overview

```
┌─────────────────────────────────────────────────────────┐
│                     Terminal UI (ratatui)                 │
│  ┌──────────────┬────────────────────────┬────────────┐  │
│  │  User List   │      Chat View         │ Status Bar │  │
│  │  (DMs/Groups)│  (messages + typing)   │ [E2E] info │  │
│  └──────────────┴────────────────────────┴────────────┘  │
│                      Input Bar                            │
└───────────────────────────┬─────────────────────────────┘
                            │ tokio::select! event loop
          ┌─────────────────┼──────────────────┐
          │                 │                  │
   Crossterm events   Network events       250ms tick
   (keyboard input)   (TCP messages)    (title, typing)
          │                 │
          │         ┌───────┴───────┐
          │         │ NetworkManager│
          │         ├───────────────┤
          │         │  TCP Server   │  ← accepts inbound connections
          │         │  ConnectionPool│ ← manages outbound connections
          │         │  DiscoveryService│ ← mDNS advertise + browse
          │         └───────────────┘
          │
   ┌──────┴──────┐
   │   SQLite DB  │
   │  (~/.ChaTTY/ │
   │  chatapp.db) │
   └─────────────┘
```

### How It Works

1. **Startup**: ChaTTY reads (or creates) `~/.ChaTTY/config.toml` and opens `~/.ChaTTY/chatapp.db`. The local user record is upserted with status `online`.

2. **Discovery**: An mDNS service record is advertised on the LAN. ChaTTY simultaneously browses for other instances. When a peer is found, a TCP connection is established and a `Hello` handshake is exchanged (username, user ID, port).

3. **Messaging**: Messages are sent as framed bincode packets over persistent TCP connections. Every message is stored in SQLite before being sent. If a peer is offline, the message is stored with `delivered = false` and retried automatically when that peer reconnects.

4. **Encryption**: On first run, ChaTTY generates an X25519 keypair saved to `~/.ChaTTY/private.key` (permissions 600). Session keys are derived via Diffie-Hellman and SHA-256, then used for AES-256-GCM AEAD encryption. The `[E2E]` indicator in the status bar confirms encryption is active.

5. **Shutdown**: On exit, ChaTTY sends a `Goodbye` broadcast to all peers, marks itself offline in the database, and restores the terminal to its original state.

### Data Storage

All application data lives in `~/.ChaTTY/`:

| File | Purpose |
|---|---|
| `config.toml` | Username, display name, port, paths |
| `chatapp.db` | All users, conversations, messages, file transfers |
| `private.key` | X25519 private key (permissions 600) |
| `downloads/` | Received files from peers |

---

## Feature List

### Core Messaging
- Real-time peer-to-peer chat over LAN (no internet required)
- Persistent message history stored in SQLite
- Messages stored before sending — no message loss even if send fails
- Unread message counter per contact shown in the user list
- Unread badge in the terminal title bar (e.g. `ChaTTY (3 unread)`)

### Peer Discovery
- Automatic peer discovery via mDNS — no manual IP configuration
- Online/offline status shown live with colored indicators (● online, ○ offline)
- Graceful offline detection via `Goodbye` broadcast on exit
- Peers re-appear online automatically when they reconnect

### Delivery & Read Receipts
- Single checkmark (✓) shown immediately on send
- Double checkmark (✓✓) shown when the peer receives the message
- Read receipts sent when the recipient opens the conversation

### Typing Indicators
- Live "username is typing…" indicator shown above the input bar
- Typing indicator automatically clears 3 seconds after the user stops typing

### Offline Message Delivery
- Messages sent while a peer is offline are stored in the database
- Automatically retried and delivered when the peer comes back online

### Group Chat
- Create named group conversations with multiple members
- Send messages visible to all group members
- Group member sidebar shown in the chat view
- Invite additional users to existing groups
- Leave a group at any time

### File Transfer
- Send any file to a peer with `/file <path>`
- Files transferred in 64 KB chunks over the existing TCP connection
- Maximum file size: 100 MB
- SHA-256 checksum verified after transfer — partial or corrupt files rejected
- Received files saved to `~/.ChaTTY/downloads/` with collision-safe naming

### End-to-End Encryption
- X25519 Diffie-Hellman key exchange on session establishment
- AES-256-GCM authenticated encryption for all messages
- Unique 96-bit random nonce per message — no nonce reuse
- Private key stored with permissions 600 (owner read-only)
- `[E2E]` indicator in status bar confirms encrypted session

### Message Search
- Full-text search within the current conversation using `/search <query>`
- Results displayed in an overlay panel with timestamps
- Up to 50 results returned per search

### Terminal UX
- Full alternate-screen terminal UI — your shell history is preserved on exit
- Three-panel layout: user list (left), chat view (center/right), input bar (bottom)
- Keyboard-driven navigation — no mouse required
- Tab completion for slash commands
- Popup notifications for events (delivery, errors, system messages)
- URL highlighting in chat — HTTP/HTTPS links rendered in blue+underline
- Smart timestamp formatting: HH:MM (today), Mon HH:MM (this week), MM/DD HH:MM (older)
- Terminal title updated with total unread count

### Configuration & Identity
- Auto-generated username from system hostname on first run
- Override username at launch with `--name <username>`
- Override listen port at launch with `--port <port>`
- Change display name at runtime with `/nick <name>`
- Set availability status with `/status <online|away>`

### Slash Commands
See the full command reference in the [User Manual](#slash-commands) below.

### Logging & Debugging
- Structured logging via `env_logger` — enable with `RUST_LOG=debug ChaTTY`

---

## User Manual

### Installation

**From source (recommended):**
```bash
git clone <repository-url>
cd ChaTTY
cargo install --path .
```

**Build without installing:**
```bash
cargo build --release
# Binary at: ./target/release/ChaTTY
```

**Requirements:**
- Rust toolchain (stable, 2021 edition or later)
- Linux, macOS, or Windows with a terminal emulator
- Peers must be on the same LAN/subnet

---

### First Run

```bash
ChaTTY --name alice
```

On first run, ChaTTY:
1. Creates `~/.ChaTTY/config.toml` with your username and default settings
2. Opens (or creates) `~/.ChaTTY/chatapp.db`
3. Generates an X25519 keypair at `~/.ChaTTY/private.key` (permissions 600)
4. Starts advertising itself on the LAN via mDNS
5. Begins scanning for other ChaTTY instances

Other users running ChaTTY on the same network will appear in your user list within seconds — no configuration needed.

---

### Command-Line Options

```
ChaTTY [OPTIONS]

OPTIONS:
    --name <username>   Set your display name (overrides config)
    --port <port>       Set listen port (default: 7878)
    --help, -h          Show help and exit
```

**Examples:**
```bash
ChaTTY                        # Use saved config
ChaTTY --name bob             # Override display name
ChaTTY --name alice --port 7900  # Override both
RUST_LOG=debug ChaTTY         # Enable debug logging
```

---

### UI Layout

```
┌─[ChaTTY][E2E] alice | 2 online | Port: 7878──────────────────┐  ← Status Bar
│                                                               │
│  Direct Messages    │  bob                          12:34     │
│  ● bob              │  > hey alice, you around?              │
│  ○ carol [2]        │                                         │
│                     │  alice                        12:35     │
│  Groups             │  > yeah! what's up?                    │
│  # myteam           │                                         │
│                     │  bob is typing…                         │
├─────────────────────┴───────────────────────────────────────-─┤  ← Input Bar
│  > _                                                          │
└───────────────────────────────────────────────────────────────┘
```

**Panels:**
- **Status Bar** (top): App name, `[E2E]` encryption indicator, your username, online peer count, listen port
- **User List** (left): Shows Direct Messages and Groups. Online peers have a green `●`, offline peers have a grey `○`. Unread counts shown as `[N]`.
- **Chat View** (center/right): Message history for the selected conversation. System messages are centered and dimmed. URLs are highlighted in blue.
- **Input Bar** (bottom): Your current message. Shows `"username is typing…"` above when a peer is typing.

---

### Keyboard Controls

#### User List (navigation mode)

| Key | Action |
|---|---|
| `↑` / `↓` | Move selection up/down |
| `Enter` | Open conversation with selected user |
| `q` | Quit ChaTTY |

#### Chat View (chat mode)

| Key | Action |
|---|---|
| `←` / `→` | Move cursor left/right in input |
| `Home` | Move cursor to start of input |
| `End` | Move cursor to end of input |
| `Backspace` | Delete character before cursor |
| `Delete` | Delete character after cursor |
| `Enter` | Send message or execute command |
| `Tab` | Auto-complete slash command |
| `Page Up` | Scroll message history up |
| `Page Down` | Scroll message history down |
| `Esc` | Close search overlay / close popup / go back to user list |
| `Ctrl+C` | Quit ChaTTY (from any state) |

---

### Slash Commands

Type any command in the input bar and press `Enter`. Use `Tab` after typing `/` to autocomplete.

#### General

| Command | Description |
|---|---|
| `/help` | Show a popup listing all available commands |
| `/quit` or `/q` | Exit ChaTTY cleanly, restoring the terminal |
| `/clear` | Clear the current chat view (does not delete messages from DB) |
| `/info` | Show your username, listen port, and internal user ID |

#### Identity & Status

| Command | Description |
|---|---|
| `/nick <name>` | Change your display name for this session |
| `/status online` | Set your status to online |
| `/status away` | Set your status to away |

#### Groups

| Command | Description |
|---|---|
| `/group create <name>` | Create a new group conversation named `<name>` |
| `/group invite <user>` | Invite a user to the current group |
| `/group leave` | Leave the current group and return to the user list |
| `/group list` | List all groups you are a member of |

#### File Transfer

| Command | Description |
|---|---|
| `/file <path>` | Send a file to the currently selected peer |
| `/files` | List active and recent file transfers |

#### History & Search

| Command | Description |
|---|---|
| `/search <query>` | Search the current conversation for `<query>` (up to 50 results) |
| `/history [n]` | Load the last `n` messages (default: 100) |

---

### Sending Messages

1. Navigate to a peer in the User List and press `Enter` to open the conversation.
2. Type your message in the input bar.
3. Press `Enter` to send.

Messages are stored in the local database before being sent. If the peer is currently offline, the message will be delivered automatically when they reconnect.

---

### File Transfers

**Sending a file:**
```
/file /path/to/document.pdf
```
This offers the file to the currently selected peer. They will receive a prompt to accept or reject.

**Receiving a file:**
When a peer sends you a file, you will see a popup notification. Accepted files are saved to `~/.ChaTTY/downloads/`. If a file with the same name already exists, a suffix (`_1`, `_2`, …) is appended automatically.

**Integrity verification:**
After the transfer completes, ChaTTY verifies the SHA-256 checksum of the received file against the value provided by the sender. A corrupted or incomplete file is deleted automatically.

---

### Searching Messages

While in a conversation, type:
```
/search hello world
```

A search overlay appears above the input bar showing all matching messages with timestamps, up to 50 results. Press `Esc` to close the overlay.

---

### Group Chat

**Create a group:**
```
/group create myteam
```
You are automatically placed in the new group conversation.

**Invite a member:**
```
/group invite bob
```
Bob receives a group invite and can join the conversation.

**List your groups:**
```
/group list
```

**Leave a group:**
```
/group leave
```
You are removed from the group and returned to the user list.

---

### Encryption

ChaTTY automatically negotiates end-to-end encrypted sessions with peers. When encryption is active, `[E2E]` appears in the status bar. No configuration is required.

Your private key is stored at `~/.ChaTTY/private.key` with file permissions `600` (only your user account can read it). Never share this file.

---

### Troubleshooting

**Peers are not appearing in my user list.**
- Ensure both machines are on the same LAN/subnet. mDNS does not cross router boundaries.
- Check that UDP port 5353 (mDNS) and TCP port 7878 (or your configured port) are not blocked by a firewall.
- Try running with `RUST_LOG=debug ChaTTY` and look for mDNS discovery messages.

**Messages are not being delivered.**
- Messages are retried automatically when the peer reconnects. They are stored safely in `~/.ChaTTY/chatapp.db`.
- Run `/info` on both sides to confirm the ports match expectations.

**The terminal is garbled after a crash.**
Run `reset` in your shell to restore normal terminal state.

**Checking logs:**
```bash
RUST_LOG=debug ChaTTY 2>debug.log
```

---

### Uninstalling

```bash
cargo uninstall ChaTTY    # Remove the binary
rm -rf ~/.ChaTTY/          # Remove all data (messages, keys, config)
```

> **Warning:** Removing `~/.ChaTTY/` permanently deletes your message history, encryption keys, and configuration.

---

*ChaTTY v0.1.0 — P2P LAN terminal chat with end-to-end encryption.*
