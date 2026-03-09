# ChaTTY — Setup & Usage Guide

A peer-to-peer LAN terminal chat app. No servers, no accounts — just you and your friends on the same network.

---

## Prerequisites

- **Rust toolchain** (1.70+): Install from [rustup.rs](https://rustup.rs)
  ```bash
  curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
  source ~/.cargo/env
  ```
- **A LAN connection**: Both machines must be on the same local network (Wi-Fi or Ethernet)

---

## Installation

### Option 1: Build from source

```bash
git clone <repo-url> && cd ChaTTY
cargo build --release
```

The binary is at `target/release/ChaTTY`. Optionally install it system-wide:

```bash
sudo cp target/release/ChaTTY /usr/local/bin/
```

### Option 2: cargo install (if published)

```bash
cargo install chatty
```

---

## Quick Start

### 1. First run

```bash
ChaTTY --name yourname
```

This creates `~/.ChaTTY/` with:
- `config.toml` — your username, port, etc.
- `chatapp.db` — local message history (SQLite)
- `chatty.log` — debug/runtime logs

### 2. Your friend starts ChaTTY on their machine

```bash
ChaTTY --name friendname
```

If both machines are on the same LAN, **mDNS auto-discovery** will find each other within a few seconds. Your friend will appear in the sidebar automatically.

### 3. Chat!

- Use **↑/↓ arrow keys** to select a user from the sidebar
- Press **Enter** to open a chat
- Type your message and press **Enter** to send
- Press **Esc** to go back to the user list

---

## CLI Options

| Flag | Description | Default |
|------|-------------|---------|
| `--name <username>` | Set your display name | system username |
| `--port <port>` | TCP listen port | `7878` |
| `--peer <host:port>` | Connect to a peer directly (repeatable) | — |
| `--data-dir <path>` | Override data directory | `~/.ChaTTY/` |
| `--help` | Show help | — |

### Examples

```bash
# Basic usage
ChaTTY --name alice

# Custom port
ChaTTY --name bob --port 7879

# Direct connection (bypasses mDNS, useful for testing or firewalled networks)
ChaTTY --name bob --port 7879 --peer 192.168.1.10:7878

# Multiple peers
ChaTTY --name charlie --peer 192.168.1.10:7878 --peer 192.168.1.11:7879
```

---

## Slash Commands

Type these in the chat input:

| Command | Description |
|---------|-------------|
| `/help` | Show available commands |
| `/nick <name>` | Change your display name |
| `/status <online\|away\|busy>` | Set your status |
| `/file <path>` | Send a file to the current chat |
| `/group <name>` | Create a group chat |
| `/quit` | Exit ChaTTY |

---

## Connecting with a Friend

### Automatic (mDNS) — recommended for LAN

Both of you just run ChaTTY on the same network. mDNS discovery handles the rest:

```
# Machine A (you)
ChaTTY --name alice

# Machine B (your friend)
ChaTTY --name bob
```

Peers appear in the sidebar within 5–10 seconds.

> **Note**: mDNS requires UDP multicast on port 5353. Most home/office networks allow this by default. If peers don't appear, check your firewall or use the `--peer` flag below.

### Manual (--peer flag)

If mDNS doesn't work (corporate firewall, VPN, testing on the same machine):

1. **You** start ChaTTY and note your IP address:
   ```bash
   # Find your IP
   ip addr show | grep "inet " | grep -v 127.0.0.1
   # Example output: inet 192.168.1.10/24

   ChaTTY --name alice
   ```

2. **Your friend** connects to you directly:
   ```bash
   ChaTTY --name bob --peer 192.168.1.10:7878
   ```

The connection is bidirectional — once bob connects, alice sees bob and can send messages too.

---

## Testing on a Single Machine

mDNS discovery doesn't work between two instances on the same computer (the system's mDNS daemon intercepts multicast traffic). Use `--peer` and `--data-dir` instead:

**Terminal 1:**
```bash
ChaTTY --name alice --port 7878 --data-dir ~/.ChaTTY-alice
```

**Terminal 2:**
```bash
ChaTTY --name bob --port 7879 --data-dir ~/.ChaTTY-bob --peer 127.0.0.1:7878
```

Bob will connect to alice directly. Both will see each other in the sidebar.

---

## Keyboard Shortcuts

| Key | Action |
|-----|--------|
| `↑` / `↓` | Navigate user list or scroll chat |
| `Enter` | Open chat / Send message |
| `Esc` | Go back to user list |
| `Tab` | Autocomplete commands |
| `Ctrl+C` | Quit |

---

## Logs & Troubleshooting

### Log file

Logs are written to `~/.ChaTTY/chatty.log` (or `<data-dir>/chatty.log`).

Watch logs in real-time:
```bash
tail -f ~/.ChaTTY/chatty.log
```

For more verbose output:
```bash
RUST_LOG=debug ChaTTY --name alice
```

### Common issues

| Problem | Solution |
|---------|----------|
| Peer not appearing in sidebar | Check both are on same LAN. Try `--peer <ip>:<port>` |
| "Address already in use" | Another ChaTTY (or other app) is using that port. Use `--port <different-port>` |
| Firewall blocking | Allow TCP on port 7878 and UDP on port 5353 (mDNS) |
| Messages not sending | Check `chatty.log` for connection errors |
| TUI display broken | Run `reset` in terminal, then restart ChaTTY |

### Firewall rules (if needed)

```bash
# Linux (firewalld)
sudo firewall-cmd --add-port=7878/tcp --permanent
sudo firewall-cmd --add-service=mdns --permanent
sudo firewall-cmd --reload

# Linux (ufw)
sudo ufw allow 7878/tcp
sudo ufw allow 5353/udp

# macOS — mDNS works out of the box, just allow the TCP port
```

---

## Data Storage

All data is stored locally in `~/.ChaTTY/`:

```
~/.ChaTTY/
├── config.toml    # Username, port, settings
├── chatapp.db     # Message history (SQLite)
└── chatty.log     # Runtime logs
```

To reset everything:
```bash
rm -rf ~/.ChaTTY
```

---

## Architecture (for the curious)

- **P2P**: No central server. Each instance is both client and server.
- **mDNS**: Automatic peer discovery via `_chatty._tcp.local.` service type.
- **TCP**: All messages sent over TCP with length-prefixed binary frames (bincode).
- **SQLite**: Local storage for users, conversations, and message history.
- **Encryption**: X25519 key exchange + AES-256-GCM (protocol-ready).

---

## Uninstall

```bash
rm -rf ~/.ChaTTY                      # Remove data
sudo rm /usr/local/bin/ChaTTY         # Remove binary (if installed)
```
