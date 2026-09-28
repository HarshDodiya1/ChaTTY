#!/usr/bin/env bun

// Compile standalone ChaTTY binaries and package them for release.
//
//   bun scripts/build.ts                         # host platform only
//   bun scripts/build.ts --version 2.1.0 darwin-arm64 linux-x64
//
// Output: dist/chatty-<version>-<target>.tar.gz (+ .sha256), each containing `chatty`.

import fs from "node:fs";
import path from "node:path";
import { $ } from "bun";
import pkg from "../package.json" with { type: "json" };

export const TARGETS = ["darwin-arm64", "darwin-x64", "linux-x64", "linux-arm64"] as const;
type Target = (typeof TARGETS)[number];

const hostTarget = (): Target => {
  const os = process.platform === "darwin" ? "darwin" : "linux";
  const arch = process.arch === "arm64" ? "arm64" : "x64";
  return `${os}-${arch}` as Target;
};

const args = process.argv.slice(2);
let version = pkg.version;
const targets: Target[] = [];
for (let i = 0; i < args.length; i++) {
  const a = args[i]!;
  if (a === "--version") {
    version = (args[++i] ?? "").replace(/^v/, "");
  } else if ((TARGETS as readonly string[]).includes(a)) {
    targets.push(a as Target);
  } else {
    console.error(`unknown argument ${a}; targets: ${TARGETS.join(", ")}`);
    process.exit(2);
  }
}
if (!/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(version)) {
  console.error(`invalid version "${version}"`);
  process.exit(2);
}
if (targets.length === 0) targets.push(hostTarget());

const root = path.resolve(import.meta.dir, "..");
const dist = path.join(root, "dist");
fs.mkdirSync(dist, { recursive: true });

for (const target of targets) {
  const outDir = path.join(dist, target);
  fs.rmSync(outDir, { recursive: true, force: true });
  fs.mkdirSync(outDir, { recursive: true });
  const bin = path.join(outDir, "chatty");
  console.log(`▸ building ${target} (v${version})`);
  const result = await Bun.build({
    entrypoints: [path.join(root, "src/cli.tsx")],
    // x64 uses Bun's "baseline" build so CPUs without AVX2 can run it too.
    compile: {
      target: `bun-${target}${target.endsWith("x64") ? "-baseline" : ""}` as Bun.Build.CompileTarget,
      outfile: bin,
    },
    minify: true,
    define: {
      "process.env.DEV": '"false"',
      CHATTY_VERSION: JSON.stringify(version),
    },
  });
  if (!result.success) {
    for (const log of result.logs) console.error(log);
    process.exit(1);
  }
  // macOS refuses to run unsigned arm64 binaries; an ad-hoc signature is enough.
  if (target.startsWith("darwin") && process.platform === "darwin") {
    await $`codesign --force --sign - ${bin}`.quiet();
  }
  const tarball = path.join(dist, `chatty-${version}-${target}.tar.gz`);
  await $`tar -czf ${tarball} -C ${outDir} chatty`;
  const sha = new Bun.CryptoHasher("sha256").update(await Bun.file(tarball).arrayBuffer()).digest("hex");
  await Bun.write(`${tarball}.sha256`, `${sha}  ${path.basename(tarball)}\n`);
  console.log(`  ${path.relative(root, tarball)}  ${sha}`);
}
