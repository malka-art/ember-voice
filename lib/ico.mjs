// A Windows .ico file holding PNG images, one per size (Windows Vista and
// later read PNG entries directly). `images`: [{ size, png: Buffer }].
export function buildIco(images) {
  const sorted = [...images].sort((a, b) => a.size - b.size);
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // 1 = icon
  header.writeUInt16LE(sorted.length, 4);
  const entries = [];
  let offset = 6 + 16 * sorted.length;
  for (const { size, png } of sorted) {
    const entry = Buffer.alloc(16);
    entry.writeUInt8(size >= 256 ? 0 : size, 0); // 0 means 256
    entry.writeUInt8(size >= 256 ? 0 : size, 1);
    entry.writeUInt8(0, 2); // no palette
    entry.writeUInt8(0, 3);
    entry.writeUInt16LE(1, 4); // colour planes
    entry.writeUInt16LE(32, 6); // bits per pixel
    entry.writeUInt32LE(png.length, 8);
    entry.writeUInt32LE(offset, 12);
    offset += png.length;
    entries.push(entry);
  }
  return Buffer.concat([header, ...entries, ...sorted.map((image) => image.png)]);
}
