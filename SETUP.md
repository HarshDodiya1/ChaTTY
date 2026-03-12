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

### Option 1: Build from source (recommended)

```bash
git clone <repo-url> && cd ChaTTY
cargo build --release
```

The binary is created at `./target/release/ChaTTY`.

**To run it directly (without installing):**
```bash
./target/release/ChaTTY --name yourname
```

**To install system-wide (so you can run `ChaTTY` from anywhere):**
```bash
# Linux/macOS - install to /usr/local/bin
sudo cp target/release/ChaTTY /usr/local/bin/

# Or install to your user's bin directory (no sudo needed)
mkdir -p ~/.local/bin
cp target/release/ChaTTY ~/.local/bin/

# Make sure ~/.local/bin is in your PATH (add to ~/.bashrc or ~/.zshrc if not)
echo 'export PATH="$HOME/.local/bin:$PATH"' >> ~/.bashrc
source ~/.bashrc
```

### Option 2: cargo install

```bash
# From the project directory
cargo install --path .

# This installs to ~/.cargo/bin/ which should already be in your PATH
```

### Verify installation

```bash
# Check if ChaTTY is accessible
which ChaTTY
# Should output: /usr/local/bin/ChaTTY or ~/.local/bin/ChaTTY or ~/.cargo/bin/ChaTTY

# Or just run it
ChaTTY --help
```

---

## Quick Start

### 1. First run

```bash
# If installed system-wide:
ChaTTY --name yourname

# Or if running from build directory:
./target/release/ChaTTY --name yourname
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

> **Note:** All examples below assume ChaTTY is installed in your PATH.  
> If not, replace `ChaTTY` with `./target/release/ChaTTY`

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
# If installed:
ChaTTY --name alice --port 7878 --data-dir ~/.ChaTTY-alice

# Or from build directory:
./target/release/ChaTTY --name alice --port 7878 --data-dir ~/.ChaTTY-alice
```

**Terminal 2:**
```bash
# If installed:
ChaTTY --name bob --port 7879 --data-dir ~/.ChaTTY-bob --peer 127.0.0.1:7878

# Or from build directory:
./target/release/ChaTTY --name bob --port 7879 --data-dir ~/.ChaTTY-bob --peer 127.0.0.1:7878
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
| `ChaTTY: command not found` | The binary isn't in your PATH. Either run `./target/release/ChaTTY` directly, or install it (see Installation section above) |
| **Peers not appearing (different machines on same WiFi)** | Most WiFi routers have "Client Isolation" / "AP Isolation" enabled, which blocks mDNS. **Use `--peer` flag instead** (see below) |
| Peer not appearing in sidebar | Check both are on same LAN. Try `--peer <ip>:<port>` |
| "Address already in use" | Another ChaTTY (or other app) is using that port. Use `--port <different-port>` |
| Firewall blocking | Allow TCP on port 7878 and UDP on port 5353 (mDNS) |
| Messages not sending | Check `chatty.log` for connection errors |
| TUI display broken | Run `reset` in terminal, then restart ChaTTY |

### Peers not showing up? Use --peer flag

**mDNS auto-discovery often fails** on WiFi networks due to router settings (AP isolation, multicast filtering). The solution is to connect directly using IP addresses:

**Step 1: Find your IP address**
```bash
# Linux
ip addr show | grep "inet " | grep -v 127.0.0.1

# macOS  
ifconfig | grep "inet " | grep -v 127.0.0.1
```

**Step 2: Start ChaTTY on both machines with --peer**

Machine A (IP: 192.168.1.10):
```bash
./target/release/ChaTTY --name harsh --peer 192.168.1.20:7878
```

Machine B (IP: 192.168.1.20):
```bash
./target/release/ChaTTY --name rishabh --peer 192.168.1.10:7878
```

**Important:** Both machines should use `--peer` pointing to each other for reliable two-way connection.

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
