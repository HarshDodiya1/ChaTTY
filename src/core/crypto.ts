// End-to-end encryption.
//
// Every peer owns a long-lived Ed25519 identity key (stored with mode 600).
// Every TCP connection performs a fresh X25519 exchange: each side sends an
// ephemeral public key signed by its identity key. Both sides derive two
// directional AES-256-GCM keys via HKDF-SHA256. Nonces are per-direction
// 96-bit counters, so replayed, reordered or dropped frames fail to decrypt.

import crypto, { type KeyObject } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const b64 = (buf: Uint8Array) => Buffer.from(buf).toString("base64url");
const unb64 = (s: string) => Buffer.from(s, "base64url");

function rawPublic(key: KeyObject): Buffer {
  const jwk = key.export({ format: "jwk" });
  if (!jwk.x) throw new Error("not an OKP key");
  return unb64(jwk.x);
}

function importPublic(raw: Buffer, crv: "Ed25519" | "X25519"): KeyObject {
  if (raw.length !== 32) throw new Error(`invalid ${crv} public key length`);
  return crypto.createPublicKey({ key: { kty: "OKP", crv, x: b64(raw) }, format: "jwk" });
}

export class Identity {
  private constructor(
    private readonly privateKey: KeyObject,
    readonly publicKey: KeyObject,
  ) {}

  static generate(): Identity {
    const { privateKey, publicKey } = crypto.generateKeyPairSync("ed25519");
    return new Identity(privateKey, publicKey);
  }

  /** Load the identity from `file`, creating it (mode 600) when missing. */
  static loadOrCreate(file: string): Identity {
    if (fs.existsSync(file)) {
      const pem = fs.readFileSync(file, "utf8");
      const privateKey = crypto.createPrivateKey(pem);
      return new Identity(privateKey, crypto.createPublicKey(privateKey));
    }
    const id = Identity.generate();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const pem = id.privateKey.export({ format: "pem", type: "pkcs8" }) as string;
    fs.writeFileSync(file, pem, { mode: 0o600 });
    fs.chmodSync(file, 0o600);
    return id;
  }

  get publicKeyB64(): string {
    return b64(rawPublic(this.publicKey));
  }

  sign(data: Uint8Array): string {
    return b64(crypto.sign(null, data, this.privateKey));
  }

  static verify(identityKeyB64: string, data: Uint8Array, sigB64: string): boolean {
    try {
      const key = importPublic(unb64(identityKeyB64), "Ed25519");
      return crypto.verify(null, data, key, unb64(sigB64));
    } catch {
      return false;
    }
  }
}

/** Human-comparable fingerprint of an identity key: 8 groups of 4 hex chars. */
export function fingerprint(identityKeyB64: string): string {
  const hex = crypto.createHash("sha256").update(unb64(identityKeyB64)).digest("hex").slice(0, 32);
  return hex.match(/.{4}/g)!.join(" ").toUpperCase();
}

/**
 * Safety number for a pair of identities — identical on both sides regardless
 * of order, so two people can compare it out loud.
 */
export function safetyNumber(keyA: string, keyB: string): string {
  const [x, y] = [keyA, keyB].sort();
  const digest = crypto.createHash("sha256").update(unb64(x!)).update(unb64(y!)).digest();
  const groups: string[] = [];
  for (let i = 0; i < 6; i++) groups.push(String(digest.readUInt32BE(i * 4) % 100000).padStart(5, "0"));
  return groups.join(" ");
}

export class Ephemeral {
  private readonly privateKey: KeyObject;
  readonly publicKeyB64: string;

  constructor() {
    const pair = crypto.generateKeyPairSync("x25519");
    this.privateKey = pair.privateKey;
    this.publicKeyB64 = b64(rawPublic(pair.publicKey));
  }

  agree(peerPublicB64: string): Buffer {
    const peer = importPublic(unb64(peerPublicB64), "X25519");
    return crypto.diffieHellman({ privateKey: this.privateKey, publicKey: peer });
  }
}

/** Bytes signed in a handshake. Binds the ephemeral key to user id, role and protocol. */
export function handshakeTranscript(role: "hello" | "hello_ack", userId: string, ephemeralKey: string): Uint8Array {
  return new TextEncoder().encode(`chatty-v2|${role}|${userId}|${ephemeralKey}`);
}

const NONCE_BYTES = 12;
const TAG_BYTES = 16;

export class Session {
  private sendCounter = 0n;
  private recvCounter = 0n;

  private constructor(
    private readonly sendKey: Buffer,
    private readonly recvKey: Buffer,
  ) {}

  /**
   * Derive a session. `dialerEph`/`acceptorEph` are the two ephemeral public keys,
   * `isDialer` says which side we are. Both sides end up with mirrored keys.
   */
  static derive(shared: Buffer, dialerEph: string, acceptorEph: string, isDialer: boolean): Session {
    const salt = crypto.createHash("sha256").update(unb64(dialerEph)).update(unb64(acceptorEph)).digest();
    const okm = Buffer.from(crypto.hkdfSync("sha256", shared, salt, "chatty-v2/session-keys", 64));
    const d2a = okm.subarray(0, 32);
    const a2d = okm.subarray(32, 64);
    return isDialer ? new Session(d2a, a2d) : new Session(a2d, d2a);
  }

  private static nonce(counter: bigint): Buffer {
    const n = Buffer.alloc(NONCE_BYTES);
    n.writeBigUInt64BE(counter, 4);
    return n;
  }

  seal(plaintext: Uint8Array): Buffer {
    const nonce = Session.nonce(this.sendCounter++);
    const cipher = crypto.createCipheriv("aes-256-gcm", this.sendKey, nonce);
    const ct = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    return Buffer.concat([ct, cipher.getAuthTag()]);
  }

  open(sealed: Uint8Array): Buffer {
    if (sealed.length < TAG_BYTES) throw new Error("sealed frame too short");
    const buf = Buffer.from(sealed);
    const nonce = Session.nonce(this.recvCounter);
    const decipher = crypto.createDecipheriv("aes-256-gcm", this.recvKey, nonce);
    decipher.setAuthTag(buf.subarray(buf.length - TAG_BYTES));
    const pt = Buffer.concat([decipher.update(buf.subarray(0, buf.length - TAG_BYTES)), decipher.final()]);
    this.recvCounter++;
    return pt;
  }
}

export function sha256Hex(data: Uint8Array | string): string {
  return crypto.createHash("sha256").update(data).digest("hex");
}

export async function sha256File(file: string): Promise<string> {
  const hash = crypto.createHash("sha256");
  await new Promise<void>((resolve, reject) => {
    fs.createReadStream(file)
      .on("data", (c) => hash.update(c))
      .on("end", () => resolve())
      .on("error", reject);
  });
  return hash.digest("hex");
}
