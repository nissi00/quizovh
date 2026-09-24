const crcTable = (() => {
  const table = new Uint32Array(256);
  for (let index = 0;index < 256;index += 1) {
    let value = index;
    for (let bit = 0;bit < 8;bit += 1) value = (value & 1) ? (0xedb88320 ^ (value >>> 1)) : (value >>> 1);
    table[index] = value >>> 0;
  }
  return table;
})();

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function dosTimeDate(date = new Date()) {
  const year = Math.max(1980,date.getUTCFullYear());
  return {
    time:(date.getUTCHours() << 11) | (date.getUTCMinutes() << 5) | Math.floor(date.getUTCSeconds() / 2),
    date:((year - 1980) << 9) | ((date.getUTCMonth() + 1) << 5) | date.getUTCDate()
  };
}

export function zipEntry(nameValue,data,offset = 0,date = new Date()) {
    const name = Buffer.from(nameValue,'utf8'),crc = crc32(data),stamp = dosTimeDate(date);
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50,0);header.writeUInt16LE(20,4);header.writeUInt16LE(0x0800,6);header.writeUInt16LE(0,8);
    header.writeUInt16LE(stamp.time,10);header.writeUInt16LE(stamp.date,12);header.writeUInt32LE(crc,14);header.writeUInt32LE(data.length,18);header.writeUInt32LE(data.length,22);header.writeUInt16LE(name.length,26);
    const directory = Buffer.alloc(46);
    directory.writeUInt32LE(0x02014b50,0);directory.writeUInt16LE(20,4);directory.writeUInt16LE(20,6);directory.writeUInt16LE(0x0800,8);directory.writeUInt16LE(0,10);
    directory.writeUInt16LE(stamp.time,12);directory.writeUInt16LE(stamp.date,14);directory.writeUInt32LE(crc,16);directory.writeUInt32LE(data.length,20);directory.writeUInt32LE(data.length,24);directory.writeUInt16LE(name.length,28);directory.writeUInt32LE(offset,42);
    return {localParts:[header,name,data],localLength:header.length + name.length + data.length,centralParts:[directory,name]};
}

export function zipFooter(centralParts,localSize,fileCount) {
  const centralSize = centralParts.reduce((sum,part) => sum + part.length,0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50,0);end.writeUInt16LE(fileCount,8);end.writeUInt16LE(fileCount,10);end.writeUInt32LE(centralSize,12);end.writeUInt32LE(localSize,16);
  return [...centralParts,end];
}

export function zipFiles(files) {
  const local = [],central = [];
  let offset = 0;
  for (const file of files) {
    const entry = zipEntry(file.name,file.data,offset);
    local.push(...entry.localParts);
    central.push(...entry.centralParts);
    offset += entry.localLength;
  }
  return Buffer.concat([...local,...zipFooter(central,offset,files.length)]);
}
