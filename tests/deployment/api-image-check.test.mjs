// What the backup's image check detects (ops/api-image-check.mjs, ADR 0010, ADR 0029), on real
// WebP variants produced by the API's own Sharp.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import {
  checkAssets,
  webpStructureProblem,
} from "../../ops/api-image-check.mjs";

const sharp = createRequire(
  resolve(import.meta.dirname, "../../apps/api/package.json"),
)("sharp");

const noise = (size) =>
  sharp(
    Buffer.from(
      Array.from({ length: size * size * 3 }, (_, i) => (i * 37) % 251),
    ),
    {
      raw: { width: size, height: size, channels: 3 },
    },
  );
const lossy = () => noise(64).webp({ quality: 82 }).toBuffer();
const lossless = () => noise(32).webp({ lossless: true }).toBuffer();

function store(files) {
  const dir = mkdtempSync(join(tmpdir(), "whiteoven-image-check-"));
  const tenant = randomUUID();
  const lines = [];
  for (const variants of files) {
    const asset = randomUUID();
    lines.push(`${tenant} ${asset}`);
    const path = join(dir, "tenants", tenant, asset);
    mkdirSync(path, { recursive: true });
    for (const [variant, bytes] of Object.entries(variants))
      writeFileSync(join(path, `${variant}.webp`), bytes);
  }
  return { dir, list: `${lines.join("\n")}\n` };
}
async function check(files) {
  const { dir, list } = store(files);
  try {
    return await checkAssets(list, dir, sharp);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("valid lossy and lossless variants pass, many at once", async () => {
  const assets = [];
  for (let i = 0; i < 6; i += 1)
    assets.push({ thumbnail: await lossless(), menu: await lossy() });
  const result = await check(assets);
  assert.deepEqual(result.problems, []);
  assert.equal(result.checked, 6);
});

test("a missing variant is reported", async () => {
  const result = await check([{ menu: await lossy() }]);
  assert.equal(result.problems.length, 1);
  assert.match(result.problems[0], /thumbnail\.webp: ausente/);
});

test("a truncated file is reported", async () => {
  const bytes = await lossy();
  const result = await check([
    { thumbnail: bytes, menu: bytes.subarray(0, bytes.length - 40) },
  ]);
  assert.match(result.problems[0], /menu\.webp: tamanho RIFF diferente/);
});

test("a wrong signature is reported", async () => {
  const bytes = Buffer.from(await lossy());
  bytes.write("RIFX", 0, "latin1");
  assert.match(webpStructureProblem(bytes), /RIFF/);
  const webp = Buffer.from(await lossy());
  webp.write("WEBQ", 8, "latin1");
  assert.match(webpStructureProblem(webp), /WEBP/);
});

test("internal corruption with a correct RIFF size is reported", async () => {
  const good = await lossy();
  assert.equal(webpStructureProblem(good), null);
  // VP8 key frame start code broken; RIFF size untouched.
  const startCode = Buffer.from(good);
  const vp8 = startCode.indexOf("VP8 ", 12, "latin1");
  startCode[vp8 + 8 + 3] = 0x00;
  // Chunk size no longer tiling the file; RIFF size untouched.
  const chunk = Buffer.from(good);
  chunk.writeUInt32LE(chunk.readUInt32LE(vp8 + 4) - 2, vp8 + 4);
  // Frame header dimensions and partition zeroed: structure intact, bitstream unusable.
  const content = Buffer.from(good);
  content.fill(0, vp8 + 8 + 6, content.length);
  const lossless32 = Buffer.from(await lossless());
  const vp8l = lossless32.indexOf("VP8L", 12, "latin1");
  lossless32[vp8l + 8] = 0x00;
  const result = await check([
    { thumbnail: startCode, menu: chunk },
    { thumbnail: content, menu: lossless32 },
  ]);
  assert.equal(result.problems.length, 4, result.problems.join("\n"));
  assert.match(result.problems[0], /quadro VP8/);
  assert.match(result.problems[1], /chunk|cobrem/);
  assert.match(result.problems[2], /não decodifica/);
  assert.match(result.problems[3], /VP8L/);
});

test("an oversized file is refused without being decoded", async () => {
  const big = Buffer.alloc(16 * 1024 * 1024 + 1);
  big.write("RIFF", 0, "latin1");
  big.writeUInt32LE(big.length - 8, 4);
  big.write("WEBP", 8, "latin1");
  const result = await check([{ thumbnail: await lossless(), menu: big }]);
  assert.equal(result.problems.length, 1);
  assert.match(result.problems[0], /menu\.webp: maior que/);
});

test("a directory where a variant should be is reported as missing", async () => {
  const { dir, list } = store([{ thumbnail: await lossless() }]);
  try {
    const [tenant, asset] = list.trim().split(" ");
    mkdirSync(join(dir, "tenants", tenant, asset, "menu.webp"));
    const result = await checkAssets(list, dir, sharp);
    assert.match(result.problems[0], /menu\.webp: ausente/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("an image above the pixel limit is refused", async () => {
  const huge = await sharp({
    create: { width: 6000, height: 6000, channels: 3, background: "#888" },
  })
    .webp()
    .toBuffer();
  const result = await check([{ thumbnail: await lossless(), menu: huge }]);
  assert.match(result.problems[0], /não decodifica .*pixel limit/);
});

test("a malformed list line is reported instead of skipped", async () => {
  const { dir } = store([]);
  try {
    const result = await checkAssets("../x y\n", dir, sharp);
    assert.match(result.problems[0], /linha inválida/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
