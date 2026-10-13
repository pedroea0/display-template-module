// =============================================================================
// mini-zip.mjs — dependency-free ZIP reader/writer for project-export archives
// =============================================================================
// Used by migrate-v1-views.mjs so that users without
// file-system access to data/projects can export a project from the gateway,
// migrate the .zip offline and import the result again.
//
// Scope (deliberately small, about 250 lines):
//   * read:  "stored" (0) and "deflate" (8) entries, data descriptors (flag
//            bit 3: sizes are taken from the central directory), UTF-8 and
//            CP437 names (the ZIP default without the UTF-8 flag; written back
//            as the same characters in UTF-8 with the flag set), archive
//            comment. Rejected with a clear error:
//            ZIP64, encrypted entries, multi-disk archives, other methods.
//   * write: every entry the caller did not change is copied byte-for-byte
//            (compressed data, CRC, sizes, DOS time, attributes); a changed
//            entry is re-compressed with deflate (or stored when that is
//            smaller). Extra fields are dropped and data descriptors are not
//            written (sizes go into the local header), which every unzip tool
//            and the Ignition gateway's project import accept.
//
// Compression is node:zlib inflateRawSync / deflateRawSync; CRC-32 is
// zlib.crc32 when the runtime has it (Node >= 20.15 / 22.2), else a table.
// =============================================================================
import zlib from 'node:zlib';

const SIG_LOCAL = 0x04034b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_EOCD = 0x06054b50;
const SIG_EOCD64_LOCATOR = 0x07064b50;

const FLAG_ENCRYPTED = 0x0001;

// IBM code page 437, bytes 0x80-0xFF: the ZIP name encoding when the UTF-8 flag (bit 11) is not set
// (APPNOTE 4.4.4 / appendix D). Bytes below 0x80 are ASCII.
const CP437_HIGH = 'ÇüéâäàåçêëèïîìÄÅÉæÆôöòûùÿÖÜ¢£¥₧ƒáíóúñÑªº¿⌐¬½¼¡«»░▒▓│┤╡╢╖╕╣║╗╝╜╛┐└┴┬├─┼╞╟╚╔╩╦╠═╬╧╨╤╥╙╘╒╓╫╪┘┌'
  + '█▄▌▐▀αßΓπΣσµτΦΘΩδ∞φε∩≡±≥≤⌠⌡÷≈°∙·√ⁿ²■\u00a0';

/** Decodes a CP437 name. */
export function cp437(bytes) {
  let s = '';
  for (const b of bytes) s += b < 0x80 ? String.fromCharCode(b) : CP437_HIGH[b - 0x80];
  return s;
}
const FLAG_DATA_DESCRIPTOR = 0x0008;
const FLAG_UTF8 = 0x0800;

const METHOD_STORED = 0;
const METHOD_DEFLATE = 8;

// ---- CRC-32 -----------------------------------------------------------------
let crcTable = null;
function crc32Fallback(buf) {
  if (!crcTable) {
    crcTable = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[n] = c >>> 0;
    }
  }
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = crcTable[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
export const crc32 = typeof zlib.crc32 === 'function' ? (buf) => zlib.crc32(buf) >>> 0 : crc32Fallback;

// ---- reading ------------------------------------------------------------------
/** Offset of the End Of Central Directory record (searched backwards over the max comment length). */
function findEocd(buf) {
  const min = Math.max(0, buf.length - 22 - 0xffff);
  for (let p = buf.length - 22; p >= min; p--) {
    if (buf.readUInt32LE(p) === SIG_EOCD && p + 22 + buf.readUInt16LE(p + 20) === buf.length) return p;
  }
  throw new Error('not a ZIP archive (end of central directory not found)');
}

/**
 * Parse an archive held in memory.
 * @param {Buffer} buf
 * @returns {{entries: object[], comment: Buffer}} entries in central-directory order; each has
 *   {name, isDir, method, flags, time, date, crc, compressedSize, size, raw, versionMadeBy,
 *    internalAttrs, externalAttrs}. `raw` is the still-compressed data (use entryData()).
 */
export function readZip(buf) {
  if (!Buffer.isBuffer(buf)) buf = Buffer.from(buf);
  const eocd = findEocd(buf);
  if (eocd >= 20 && buf.readUInt32LE(eocd - 20) === SIG_EOCD64_LOCATOR) {
    throw new Error('ZIP64 archives are not supported; unzip, migrate the folder, and re-zip instead');
  }
  const disk = buf.readUInt16LE(eocd + 4);
  const count = buf.readUInt16LE(eocd + 10);
  const cdOffset = buf.readUInt32LE(eocd + 16);
  if (disk !== 0) throw new Error('multi-disk ZIP archives are not supported');
  const comment = Buffer.from(buf.subarray(eocd + 22, eocd + 22 + buf.readUInt16LE(eocd + 20)));

  const entries = [];
  let p = cdOffset;
  for (let i = 0; i < count; i++) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== SIG_CENTRAL) {
      throw new Error(`corrupt ZIP: central directory entry ${i} not found`);
    }
    const flags = buf.readUInt16LE(p + 8);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const nameBytes = buf.subarray(p + 46, p + 46 + nameLen);
    const e = {
      name: flags & FLAG_UTF8 ? nameBytes.toString('utf8') : cp437(nameBytes),
      versionMadeBy: buf.readUInt16LE(p + 4),
      flags,
      method: buf.readUInt16LE(p + 10),
      time: buf.readUInt16LE(p + 12),
      date: buf.readUInt16LE(p + 14),
      crc: buf.readUInt32LE(p + 16),
      compressedSize: buf.readUInt32LE(p + 20),
      size: buf.readUInt32LE(p + 24),
      internalAttrs: buf.readUInt16LE(p + 36),
      externalAttrs: buf.readUInt32LE(p + 38),
    };
    const localOffset = buf.readUInt32LE(p + 42);
    if (e.compressedSize === 0xffffffff || e.size === 0xffffffff || localOffset === 0xffffffff) {
      throw new Error(`ZIP64 entry "${e.name}" is not supported`);
    }
    if (flags & FLAG_ENCRYPTED) throw new Error(`encrypted entry "${e.name}" is not supported`);
    if (buf.readUInt32LE(localOffset) !== SIG_LOCAL) throw new Error(`corrupt ZIP: local header of "${e.name}" not found`);
    const dataStart = localOffset + 30 + buf.readUInt16LE(localOffset + 26) + buf.readUInt16LE(localOffset + 28);
    if (dataStart + e.compressedSize > buf.length) {
      throw new Error(`corrupt ZIP: data of "${e.name}" runs past the end of the archive`);
    }
    e.raw = buf.subarray(dataStart, dataStart + e.compressedSize);
    e.isDir = e.name.endsWith('/');
    entries.push(e);
    p += 46 + nameLen + extraLen + commentLen;
  }
  return { entries, comment };
}

/** Uncompressed bytes of an entry read by readZip(); CRC and size are verified. */
export function entryData(e) {
  let data;
  if (e.method === METHOD_STORED) data = Buffer.from(e.raw);
  else if (e.method === METHOD_DEFLATE) {
    // Cap the output at the declared size (+1 so an overlong stream still fails the size check below)
    // so a corrupt or crafted entry cannot exhaust memory before that check runs.
    try {
      data = zlib.inflateRawSync(e.raw, { maxOutputLength: Math.max(1, e.size + 1) });
    } catch (err) {
      if (err.code === 'ERR_BUFFER_TOO_LARGE' || /maxOutputLength|too large/i.test(err.message)) {
        throw new Error(`entry "${e.name}": inflates to more than its declared ${e.size} bytes`);
      }
      throw err;
    }
  }
  else throw new Error(`entry "${e.name}": compression method ${e.method} is not supported`);
  if (data.length !== e.size) throw new Error(`entry "${e.name}": size mismatch (${data.length} != ${e.size})`);
  if (crc32(data) !== e.crc) throw new Error(`entry "${e.name}": CRC mismatch`);
  return data;
}

// ---- writing ------------------------------------------------------------------
/** DOS date/time of a JS Date (local time, 2 s resolution). */
export function dosDateTime(d = new Date()) {
  const year = Math.max(1980, d.getFullYear());
  return {
    time: (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1),
    date: ((year - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
  };
}

/**
 * Build an archive.
 * @param {object[]} entries readZip() entries (copied unchanged) and/or entries with `data`
 *   (Buffer of NEW uncompressed content; `time`/`date`/attributes are kept when present).
 *   A plain new entry needs only {name, data}.
 * @param {Buffer} [comment]
 * @returns {Buffer}
 */
export function writeZip(entries, comment = Buffer.alloc(0)) {
  if (entries.length > 0xffff) throw new Error('too many entries for a non-ZIP64 archive');
  const now = dosDateTime();
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const src of entries) {
    const nameBuf = Buffer.from(src.name, 'utf8');
    const utf8 = /[^\x00-\x7f]/.test(src.name);
    let method, crc, size, payload;
    if (src.data !== undefined) {
      const data = Buffer.isBuffer(src.data) ? src.data : Buffer.from(src.data);
      const deflated = zlib.deflateRawSync(data, { level: 9 });
      const store = deflated.length >= data.length;
      method = store ? METHOD_STORED : METHOD_DEFLATE;
      payload = store ? data : deflated;
      crc = crc32(data);
      size = data.length;
    } else {
      ({ method, crc, size } = src);
      payload = src.raw;
    }
    // Bit 3 is cleared because sizes and CRC are written up front; bit 11 follows the name.
    const flags = ((src.flags || 0) & ~(FLAG_DATA_DESCRIPTOR | FLAG_UTF8)) | (utf8 ? FLAG_UTF8 : 0);
    const time = src.time ?? now.time;
    const date = src.date ?? now.date;
    const versionNeeded = src.name.endsWith('/') || method === METHOD_STORED ? 10 : 20;

    const local = Buffer.alloc(30);
    local.writeUInt32LE(SIG_LOCAL, 0);
    local.writeUInt16LE(versionNeeded, 4);
    local.writeUInt16LE(flags, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(date, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(payload.length, 18);
    local.writeUInt32LE(size, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);
    locals.push(local, nameBuf, payload);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(SIG_CENTRAL, 0);
    central.writeUInt16LE(src.versionMadeBy ?? 20, 4);
    central.writeUInt16LE(versionNeeded, 6);
    central.writeUInt16LE(flags, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt16LE(time, 12);
    central.writeUInt16LE(date, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(payload.length, 20);
    central.writeUInt32LE(size, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt16LE(0, 30);                       // extra length
    central.writeUInt16LE(0, 32);                       // comment length
    central.writeUInt16LE(0, 34);                       // disk number
    central.writeUInt16LE(src.internalAttrs || 0, 36);
    central.writeUInt32LE(src.externalAttrs || 0, 38);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, nameBuf);

    offset += 30 + nameBuf.length + payload.length;
    if (offset > 0xffffffff) throw new Error('archive too large for a non-ZIP64 writer');
  }
  const cdSize = centrals.reduce((n, b) => n + b.length, 0);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(SIG_EOCD, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cdSize, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(comment.length, 20);
  return Buffer.concat([...locals, ...centrals, eocd, comment]);
}
