import { describe, expect, test } from "bun:test";
import { deflateRawSync } from "node:zlib";

import { detectUploadFile } from "~/lib/upload-detect";

// 手工构造最小 zip(local headers + central directory + EOCD),用来复刻
// "大条目排在包首,[Content_Types].xml 被挤出 file-type 4100 字节嗅探窗"的 docx。
function crc32(buf: Uint8Array): number {
  const table: number[] = [];
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  let crc = 0 ^ -1;
  for (let i = 0; i < buf.length; i++) crc = (crc >>> 8) ^ table[(crc ^ buf[i]!) & 0xff]!;
  return (crc ^ -1) >>> 0;
}

function makeZip(entries: Array<[string, Uint8Array]>): Buffer {
  const chunks: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const [name, data] of entries) {
    const nameBuf = Buffer.from(name, "utf8");
    const compressed = deflateRawSync(data);
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(8, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0);
    cd.writeUInt16LE(20, 4);
    cd.writeUInt16LE(20, 6);
    cd.writeUInt16LE(8, 10);
    cd.writeUInt32LE(crc, 16);
    cd.writeUInt32LE(compressed.length, 20);
    cd.writeUInt32LE(data.length, 24);
    cd.writeUInt16LE(nameBuf.length, 28);
    cd.writeUInt32LE(offset, 42);
    central.push(Buffer.concat([cd, nameBuf]));
    chunks.push(local, nameBuf, compressed);
    offset += 30 + nameBuf.length + compressed.length;
  }
  const centralBuf = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...chunks, centralBuf, eocd]);
}

const DOCX_MIME = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
const encoder = new TextEncoder();
const contentTypes = encoder.encode(
  '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
);
const docXml = encoder.encode(
  '<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>hi</w:t></w:r></w:p></w:body></w:document>',
);
// 不可压缩的 8KB 条目,足以把 [Content_Types].xml 挤出 4100 字节窗口
const incompressibleBlob = crypto.getRandomValues(new Uint8Array(8000));

function asFile(bytes: Buffer | Uint8Array, name: string): File {
  return new File([bytes as unknown as BlobPart], name);
}

describe("detectUploadFile", () => {
  test("standard docx ([Content_Types].xml first) is allowed with docx mime", async () => {
    const zip = makeZip([
      ["[Content_Types].xml", contentTypes],
      ["word/document.xml", docXml],
    ]);
    const result = await detectUploadFile(asFile(zip, "report.docx"));
    expect(result).toEqual({ allowed: true, mimeType: DOCX_MIME });
  });

  test("docx with a large leading entry (sniff window miss) is still allowed", async () => {
    const zip = makeZip([
      ["docProps/thumbnail.bin", incompressibleBlob],
      ["[Content_Types].xml", contentTypes],
      ["word/document.xml", docXml],
    ]);
    const result = await detectUploadFile(asFile(zip, "report.docx"));
    expect(result).toEqual({ allowed: true, mimeType: DOCX_MIME });
  });

  test("epub detected as generic zip is allowed via extension", async () => {
    const zip = makeZip([
      ["assets/cover.bin", incompressibleBlob],
      ["META-INF/container.xml", encoder.encode("<container/>")],
    ]);
    const result = await detectUploadFile(asFile(zip, "book.epub"));
    expect(result).toEqual({ allowed: true, mimeType: "application/epub+zip" });
  });

  test("plain .zip archive stays rejected", async () => {
    const zip = makeZip([["stuff/data.bin", incompressibleBlob]]);
    const result = await detectUploadFile(asFile(zip, "archive.zip"));
    expect(result.allowed).toBe(false);
  });

  test("zip renamed to unsupported extension stays rejected", async () => {
    const zip = makeZip([["stuff/data.bin", incompressibleBlob]]);
    const result = await detectUploadFile(asFile(zip, "archive.rar"));
    expect(result.allowed).toBe(false);
  });

  test("unrecognized bytes fall back to text with extension mime", async () => {
    const result = await detectUploadFile(asFile(encoder.encode("hello\nworld"), "notes.md"));
    expect(result).toEqual({ allowed: true, mimeType: "text/markdown" });
  });
});
