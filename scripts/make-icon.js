// Wraps build/icon.png (256x256) into build/icon.ico (a single PNG-compressed entry, valid since Vista).
const fs = require('fs');
const path = require('path');
const png = fs.readFileSync(path.join(__dirname, '..', 'build', 'icon.png'));
const header = Buffer.alloc(22);
header.writeUInt16LE(0, 0); header.writeUInt16LE(1, 2); header.writeUInt16LE(1, 4);
header.writeUInt8(0, 6); header.writeUInt8(0, 7); // 0 means 256
header.writeUInt8(0, 8); header.writeUInt8(0, 9);
header.writeUInt16LE(1, 10); header.writeUInt16LE(32, 12);
header.writeUInt32LE(png.length, 14); header.writeUInt32LE(22, 18);
fs.writeFileSync(path.join(__dirname, '..', 'build', 'icon.ico'), Buffer.concat([header, png]));
