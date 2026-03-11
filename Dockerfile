# ─────────────────────────────────────────────────────────────
# Stage 1 — Builder
# Uses the official Rust image to compile a fully static binary
# via the musl target (no glibc dependency at runtime).
# ─────────────────────────────────────────────────────────────
FROM rust:slim AS builder

# Install musl toolchain for a static, dependency-free binary
RUN apt-get update && apt-get install -y \
    musl-tools \
    pkg-config \
    && rm -rf /var/lib/apt/lists/*

RUN rustup target add x86_64-unknown-linux-musl

WORKDIR /app

# Copy dependency manifests first — lets Docker cache the dep
# compilation layer separately from the source layer.
COPY Cargo.toml Cargo.lock ./

# Create a dummy main so cargo can compile dependencies without
# the real source code (speeds up rebuilds significantly).
RUN mkdir src && echo 'fn main() {}' > src/main.rs
RUN cargo build --release --target x86_64-unknown-linux-musl 2>/dev/null || true
RUN rm src/main.rs

# Now copy the real source and build
COPY src ./src
COPY tests ./tests

RUN cargo build --release --target x86_64-unknown-linux-musl

# ─────────────────────────────────────────────────────────────
# Stage 2 — Runtime
# Minimal Debian slim image — provides a working shell and
# basic utilities (needed for terminal emulation and hostname).
# Using scratch would be smaller but hostname/shell wouldn't work.
# ─────────────────────────────────────────────────────────────
FROM debian:bookworm-slim

# Install only what is needed at runtime:
# - ca-certificates: for any future TLS calls
# - hostname:        ChaTTY reads hostname for mDNS identity
RUN apt-get update && apt-get install -y \
    ca-certificates \
    hostname \
    && rm -rf /var/lib/apt/lists/*

# Copy the static binary from the builder stage
COPY --from=builder \
    /app/target/x86_64-unknown-linux-musl/release/ChaTTY \
    /usr/local/bin/ChaTTY

# Data directory — mount a volume here to persist messages and config
VOLUME ["/data"]

# Default TCP listen port
EXPOSE 7878

# Create a non-root user and pre-create /data with correct ownership
# so the Docker volume is writable when mounted.
RUN useradd -m -u 1000 chattY && \
    mkdir -p /data && \
    chown -R chattY:chattY /data

USER chattY

ENTRYPOINT ["ChaTTY", "--data-dir", "/data"]
CMD ["--name", "user"]
