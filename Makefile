.PHONY: build install test clean dev

build:
	cargo build --release

install:
	cargo install --path .

test:
	cargo test

clean:
	cargo clean
	rm -rf ~/.ChaTTY/

dev:
	RUST_LOG=debug cargo run
