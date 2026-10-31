// Checks the catalog images a backup or a restore references (ADR 0010, ADR 0029). Runs with the
// API image's Node and Sharp, in a one-off container, over a directory extracted from images.tar:
//
//   node api-image-check.mjs LIST DIR   (ops/api-backup.sh runs it; see check_images)
//
// LIST has one "tenantId assetId" per line; DIR holds tenants/<tenant>/<asset>/<variant>.webp.
// Prints the number of assets checked; on any problem prints one line per variant to stderr and
// exits 1.
//
// What it detects: a missing variant; a truncated or padded file (the RIFF size must match the
// file); a wrong signature; a chunk layout that does not tile the file exactly; a first chunk that
// is not VP8, VP8L or VP8X, or whose bitstream signature is wrong; and any content libwebp refuses
// to decode in full. What it cannot detect: altered pixel data that still decodes. No checksum is
// recorded when an image is written, so nothing can tell those bytes from the original ones.
//
// Resources: variants are checked one at a time, so at most one file and one decoded bitmap are
// in memory (measured: peak RSS about 220 MB flat from 50 to 500 assets, about 60 ms per asset
// with a 1600 px menu variant; docs/operations/api-backup-restore.md). Files above
// MAX_VARIANT_BYTES are refused unread and Sharp refuses images above 30 megapixels.
import { readFile, stat } from "node:fs/promises";
import { createRequire } from "node:module";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const VARIANTS = ["thumbnail", "menu"];
// Variants are at most 1600 px WebP at quality 82 (ADR 0010), far below this. A larger file is
// not one the API wrote, and is refused before it is read into memory.
const MAX_VARIANT_BYTES = 16 * 1024 * 1024;

/** Structural problem of a WebP file, or null when the container and bitstream headers hold. */
export function webpStructureProblem(bytes) {
  if (bytes.length < 20) return "arquivo curto demais";
  if (bytes.toString("latin1", 0, 4) !== "RIFF")
    return "assinatura RIFF ausente";
  if (bytes.toString("latin1", 8, 12) !== "WEBP")
    return "assinatura WEBP ausente";
  if (bytes.readUInt32LE(4) + 8 !== bytes.length)
    return "tamanho RIFF diferente do arquivo (truncado ou com sobra)";
  let offset = 12;
  let first = null;
  let image = false;
  while (offset < bytes.length) {
    if (offset + 8 > bytes.length) return "cabeçalho de chunk incompleto";
    const type = bytes.toString("latin1", offset, offset + 4);
    const size = bytes.readUInt32LE(offset + 4);
    const data = offset + 8;
    if (data + size > bytes.length) return `chunk ${type} ultrapassa o arquivo`;
    first ??= type;
    if (type === "VP8 ") {
      // Key frame: start code 9d 01 2a after the 3-byte frame tag.
      if (
        size < 10 ||
        bytes[data + 3] !== 0x9d ||
        bytes[data + 4] !== 0x01 ||
        bytes[data + 5] !== 0x2a
      )
        return "assinatura do quadro VP8 inválida";
      image = true;
    } else if (type === "VP8L") {
      if (size < 5 || bytes[data] !== 0x2f) return "assinatura VP8L inválida";
      image = true;
    }
    offset = data + size + (size % 2);
  }
  if (offset !== bytes.length) return "chunks não cobrem o arquivo";
  if (!["VP8 ", "VP8L", "VP8X"].includes(first))
    return `primeiro chunk inesperado (${first})`;
  if (!image) return "nenhum chunk de imagem";
  return null;
}

/** Full decode with libwebp through Sharp; returns a problem or null. */
async function decodeProblem(sharp, bytes) {
  try {
    await sharp(bytes, { failOn: "error", limitInputPixels: 30_000_000 })
      .raw()
      .toBuffer();
    return null;
  } catch (error) {
    return `não decodifica (${error instanceof Error ? error.message.split("\n")[0] : "erro"})`;
  }
}

export async function checkAssets(listText, dir, sharp) {
  const problems = [];
  let checked = 0;
  for (const line of listText.split("\n")) {
    if (!line.trim()) continue;
    const [tenant, asset, extra] = line.trim().split(" ");
    if (
      !UUID.test(tenant ?? "") ||
      !UUID.test(asset ?? "") ||
      extra !== undefined
    ) {
      problems.push(`linha inválida na lista: ${line}`);
      continue;
    }
    checked += 1;
    for (const variant of VARIANTS) {
      const path = `tenants/${tenant}/${asset}/${variant}.webp`;
      let bytes;
      try {
        const info = await stat(join(dir, path));
        if (!info.isFile()) throw new Error("not a file");
        if (info.size > MAX_VARIANT_BYTES) {
          problems.push(`${path}: maior que ${MAX_VARIANT_BYTES} bytes`);
          continue;
        }
        bytes = await readFile(join(dir, path));
      } catch {
        problems.push(`${path}: ausente`);
        continue;
      }
      const problem =
        webpStructureProblem(bytes) ?? (await decodeProblem(sharp, bytes));
      if (problem) problems.push(`${path}: ${problem}`);
    }
  }
  return { checked, problems };
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const [list, dir] = process.argv.slice(2);
  try {
    // Sharp from the API package in the current directory (the API image's working directory).
    const sharp = createRequire(join(process.cwd(), "package.json"))("sharp");
    const { checked, problems } = await checkAssets(
      await readFile(list, "utf8"),
      dir,
      sharp,
    );
    for (const problem of problems)
      process.stderr.write(
        `Imagem referenciada ausente ou inválida: ${problem}\n`,
      );
    if (problems.length) process.exit(1);
    process.stdout.write(`${checked}\n`);
  } catch (error) {
    process.stderr.write(`Verificação das imagens falhou: ${error}\n`);
    process.exit(1);
  }
}
