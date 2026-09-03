import QRCode from 'qrcode';
import zlib from 'node:zlib';

const pageWidth = 842;
const pageHeight = 595;

function latin(value) {
  return String(value ?? '')
    .normalize('NFKC')
    .replace(/[’‘]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/œ/g, 'oe')
    .replace(/Œ/g, 'OE')
    .replace(/[–—]/g, '-')
    .replace(/[^\x20-\xFF]/g, '');
}

function pdfString(value) {
  return latin(value).replace(/([\\()])/g, '\\$1');
}

function text(value, x, y, size, font = 'F1', color = '0.02 0.22 0.32', align = 'left') {
  const safe = pdfString(value);
  const estimatedWidth = latin(value).length * size * (font === 'F2' ? 0.56 : 0.5);
  const position = align === 'center' ? x - estimatedWidth / 2 : align === 'right' ? x - estimatedWidth : x;
  return `BT /${font} ${size} Tf ${color} rg 1 0 0 1 ${position.toFixed(1)} ${y} Tm (${safe}) Tj ET\n`;
}

function wrappedText(value, centerX, y, size, maxChars, font = 'F1', color) {
  const words = latin(value).split(/\s+/).filter(Boolean);
  const lines = [];
  let line = '';
  for (const word of words) {
    const candidate = line ? `${line} ${word}` : word;
    if (candidate.length > maxChars && line) {
      lines.push(line);
      line = word;
    } else line = candidate;
  }
  if (line) lines.push(line);
  return lines.slice(0, 2).map((part, index) => text(part, centerX, y - index * (size + 5), size, font, color, 'center')).join('');
}

function qrCommands(url, x, y, size) {
  const qr = QRCode.create(url, { errorCorrectionLevel: 'M' });
  const count = qr.modules.size;
  const quiet = 4;
  const cell = size / (count + quiet * 2);
  let commands = `1 1 1 rg ${x} ${y} ${size} ${size} re f\n0.02 0.22 0.32 rg\n`;
  for (let row = 0; row < count; row += 1) {
    for (let column = 0; column < count; column += 1) {
      if (!qr.modules.data[row * count + column]) continue;
      const px = x + (column + quiet) * cell;
      const py = y + (count - row - 1 + quiet) * cell;
      commands += `${px.toFixed(2)} ${py.toFixed(2)} ${cell.toFixed(2)} ${cell.toFixed(2)} re f\n`;
    }
  }
  return commands;
}

function jpegDimensions(data) {
  let offset = 2;
  while (offset + 9 < data.length) {
    if (data[offset] !== 0xff) { offset += 1; continue; }
    const marker = data[offset + 1];
    if ([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker)) {
      return { height: data.readUInt16BE(offset + 5), width: data.readUInt16BE(offset + 7), colorSpace: data[offset + 9] === 1 ? '/DeviceGray' : '/DeviceRGB' };
    }
    if (marker === 0xd8 || marker === 0xd9) { offset += 2; continue; }
    const length = data.readUInt16BE(offset + 2);
    if (length < 2) break;
    offset += length + 2;
  }
  throw new Error('Dimensions JPEG introuvables.');
}

function paeth(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
}

function pngToRgb(data) {
  if (!data.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) throw new Error('PNG invalide.');
  let offset = 8, width = 0, height = 0, bitDepth = 0, colorType = 0, interlace = 0;
  let palette = null, transparency = null;
  const compressed = [];
  while (offset + 12 <= data.length) {
    const length = data.readUInt32BE(offset);
    const type = data.toString('ascii', offset + 4, offset + 8);
    const chunk = data.subarray(offset + 8, offset + 8 + length);
    if (type === 'IHDR') {
      width = chunk.readUInt32BE(0); height = chunk.readUInt32BE(4); bitDepth = chunk[8]; colorType = chunk[9]; interlace = chunk[12];
    } else if (type === 'PLTE') palette = chunk;
    else if (type === 'tRNS') transparency = chunk;
    else if (type === 'IDAT') compressed.push(chunk);
    else if (type === 'IEND') break;
    offset += length + 12;
  }
  const channels = ({ 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 })[colorType];
  if (!width || !height || bitDepth !== 8 || interlace !== 0 || !channels || !compressed.length) throw new Error('Format PNG non pris en charge.');
  if (colorType === 3 && !palette) throw new Error('Palette PNG absente.');
  const scanline = width * channels;
  const inflated = zlib.inflateSync(Buffer.concat(compressed));
  if (inflated.length < height * (scanline + 1)) throw new Error('Données PNG incomplètes.');
  const pixels = Buffer.alloc(height * scanline);
  let sourceOffset = 0;
  for (let row = 0; row < height; row += 1) {
    const filter = inflated[sourceOffset++];
    const rowOffset = row * scanline;
    for (let column = 0; column < scanline; column += 1) {
      const raw = inflated[sourceOffset++];
      const left = column >= channels ? pixels[rowOffset + column - channels] : 0;
      const up = row ? pixels[rowOffset + column - scanline] : 0;
      const upperLeft = row && column >= channels ? pixels[rowOffset + column - scanline - channels] : 0;
      let value = raw;
      if (filter === 1) value = raw + left;
      else if (filter === 2) value = raw + up;
      else if (filter === 3) value = raw + Math.floor((left + up) / 2);
      else if (filter === 4) value = raw + paeth(left, up, upperLeft);
      else if (filter !== 0) throw new Error('Filtre PNG inconnu.');
      pixels[rowOffset + column] = value & 0xff;
    }
  }
  const rgb = Buffer.alloc(width * height * 3);
  for (let index = 0; index < width * height; index += 1) {
    const source = index * channels;
    let red, green, blue, alpha = 255;
    if (colorType === 0 || colorType === 4) red = green = blue = pixels[source];
    else if (colorType === 2 || colorType === 6) { red = pixels[source]; green = pixels[source + 1]; blue = pixels[source + 2]; }
    else {
      const paletteIndex = pixels[source];
      red = palette[paletteIndex * 3] ?? 255; green = palette[paletteIndex * 3 + 1] ?? 255; blue = palette[paletteIndex * 3 + 2] ?? 255;
      alpha = transparency?.[paletteIndex] ?? 255;
    }
    if (colorType === 4) alpha = pixels[source + 1];
    if (colorType === 6) alpha = pixels[source + 3];
    const target = index * 3;
    rgb[target] = Math.round((red * alpha + 255 * (255 - alpha)) / 255);
    rgb[target + 1] = Math.round((green * alpha + 255 * (255 - alpha)) / 255);
    rgb[target + 2] = Math.round((blue * alpha + 255 * (255 - alpha)) / 255);
  }
  return { width, height, data: zlib.deflateSync(rgb), filter: '/FlateDecode', colorSpace: '/DeviceRGB' };
}

function logoImage(certificate) {
  const data = Buffer.isBuffer(certificate.logo_data) ? certificate.logo_data : null;
  if (!data?.length) return null;
  try {
    if (certificate.logo_mime_type === 'image/jpeg') {
      const dimensions = jpegDimensions(data);
      return { ...dimensions, data, filter: '/DCTDecode' };
    }
    if (certificate.logo_mime_type === 'image/png') return pngToRgb(data);
  } catch {
    return null;
  }
  return null;
}

function logoCommands(image) {
  const maxWidth = 58, maxHeight = 42;
  const scale = Math.min(maxWidth / image.width, maxHeight / image.height);
  const width = image.width * scale, height = image.height * scale;
  const x = 43 + (maxWidth - width) / 2, y = 514 + (maxHeight - height) / 2;
  return `q ${width.toFixed(2)} 0 0 ${height.toFixed(2)} ${x.toFixed(2)} ${y.toFixed(2)} cm /Logo Do Q\n`;
}

function certificatePage(certificate, logo) {
  const score = Number(certificate.global_score || 0).toFixed(1).replace('.', ',');
  const issuedDate = new Intl.DateTimeFormat('fr-FR', { dateStyle: 'long', timeZone: 'UTC' }).format(new Date(certificate.issued_at));
  const start = new Intl.DateTimeFormat('fr-FR', { dateStyle: 'medium', timeZone: 'UTC' }).format(new Date(certificate.start_date));
  const end = new Intl.DateTimeFormat('fr-FR', { dateStyle: 'medium', timeZone: 'UTC' }).format(new Date(certificate.end_date));
  let stream = '';
  stream += '0.96 0.98 0.98 rg 0 0 842 595 re f\n';
  stream += '0.02 0.22 0.32 RG 3 w 24 24 794 547 re S\n';
  stream += '0.00 0.47 0.51 rg 24 500 794 71 re f\n';
  stream += logo ? logoCommands(logo) : text('TS', 66, 519, 24, 'F2', '1 1 1', 'center');
  stream += text('TECH SYSTEMES', logo ? 116 : 102, 522, 19, 'F2', '1 1 1');
  stream += text('CERTIFICAT DE REUSSITE', pageWidth / 2, 454, 28, 'F2', undefined, 'center');
  stream += text('Ce certificat atteste que', pageWidth / 2, 411, 14, 'F1', '0.30 0.38 0.40', 'center');
  stream += wrappedText(`${certificate.first_name} ${certificate.last_name}`, pageWidth / 2, 369, 26, 45, 'F2');
  stream += text('a suivi la formation', pageWidth / 2, 323, 14, 'F1', '0.30 0.38 0.40', 'center');
  stream += wrappedText(certificate.theme_name, pageWidth / 2, 283, 21, 58, 'F2', '0.00 0.47 0.51');
  stream += text(`Groupe : ${certificate.group_name}`, pageWidth / 2, 235, 13, 'F1', '0.30 0.38 0.40', 'center');
  stream += text(`Du ${start} au ${end}`, pageWidth / 2, 211, 13, 'F1', '0.30 0.38 0.40', 'center');
  stream += text(`Score global : ${score} %`, pageWidth / 2, 171, 18, 'F2', '0.00 0.47 0.51', 'center');
  stream += text(`Delivre le ${issuedDate}`, 74, 109, 11, 'F1', '0.30 0.38 0.40');
  stream += text(`Par ${certificate.issuer_name || 'Tech Systemes'}`, 74, 88, 11, 'F1', '0.30 0.38 0.40');
  stream += text(`N° ${certificate.certificate_number}`, 74, 57, 10, 'F2', '0.02 0.22 0.32');
  stream += qrCommands(certificate.verification_url, 683, 54, 106);
  stream += text('Verifier ce certificat', 736, 40, 8, 'F1', '0.30 0.38 0.40', 'center');
  return stream;
}

function pdfObject(number, body) {
  return Buffer.from(`${number} 0 obj\n${body}\nendobj\n`, 'latin1');
}

export function createCertificatesPdf(certificates) {
  if (!Array.isArray(certificates) || certificates.length === 0) throw new Error('Aucun certificat à générer.');
  const objects = new Map();
  const pageRefs = [];
  objects.set(1, pdfObject(1, '<< /Type /Catalog /Pages 2 0 R >>'));
  objects.set(3, pdfObject(3, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>'));
  objects.set(4, pdfObject(4, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>'));
  let nextObject = 5;
  certificates.forEach(certificate => {
    const logo = logoImage(certificate);
    let logoNumber = null;
    if (logo) {
      logoNumber = nextObject++;
      objects.set(logoNumber, Buffer.concat([
        Buffer.from(`${logoNumber} 0 obj\n<< /Type /XObject /Subtype /Image /Width ${logo.width} /Height ${logo.height} /ColorSpace ${logo.colorSpace} /BitsPerComponent 8 /Filter ${logo.filter} /Length ${logo.data.length} >>\nstream\n`, 'latin1'),
        logo.data,
        Buffer.from('\nendstream\nendobj\n', 'latin1')
      ]));
    }
    const contentNumber = nextObject++;
    const pageNumber = nextObject++;
    const content = Buffer.from(certificatePage(certificate, logo), 'latin1');
    objects.set(contentNumber, Buffer.concat([
      Buffer.from(`${contentNumber} 0 obj\n<< /Length ${content.length} >>\nstream\n`, 'latin1'),
      content,
      Buffer.from('\nendstream\nendobj\n', 'latin1')
    ]));
    objects.set(pageNumber, pdfObject(pageNumber,
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${pageWidth} ${pageHeight}] /Resources << /Font << /F1 3 0 R /F2 4 0 R >>${logoNumber ? ` /XObject << /Logo ${logoNumber} 0 R >>` : ''} >> /Contents ${contentNumber} 0 R >>`
    ));
    pageRefs.push(`${pageNumber} 0 R`);
  });
  objects.set(2, pdfObject(2, `<< /Type /Pages /Count ${pageRefs.length} /Kids [${pageRefs.join(' ')}] >>`));

  const maxObject = nextObject - 1;
  const header = Buffer.from('%PDF-1.4\n%\xE2\xE3\xCF\xD3\n', 'latin1');
  const chunks = [header];
  const offsets = [0];
  let offset = header.length;
  for (let number = 1; number <= maxObject; number += 1) {
    const object = objects.get(number);
    offsets[number] = offset;
    chunks.push(object);
    offset += object.length;
  }
  const xrefOffset = offset;
  let xref = `xref\n0 ${maxObject + 1}\n0000000000 65535 f \n`;
  for (let number = 1; number <= maxObject; number += 1) {
    xref += `${String(offsets[number]).padStart(10, '0')} 00000 n \n`;
  }
  xref += `trailer\n<< /Size ${maxObject + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  chunks.push(Buffer.from(xref, 'latin1'));
  return Buffer.concat(chunks);
}
