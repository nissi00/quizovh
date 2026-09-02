import QRCode from 'qrcode';

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

function certificatePage(certificate) {
  const score = Number(certificate.global_score || 0).toFixed(1).replace('.', ',');
  const issuedDate = new Intl.DateTimeFormat('fr-FR', { dateStyle: 'long', timeZone: 'UTC' }).format(new Date(certificate.issued_at));
  const start = new Intl.DateTimeFormat('fr-FR', { dateStyle: 'medium', timeZone: 'UTC' }).format(new Date(certificate.start_date));
  const end = new Intl.DateTimeFormat('fr-FR', { dateStyle: 'medium', timeZone: 'UTC' }).format(new Date(certificate.end_date));
  let stream = '';
  stream += '0.96 0.98 0.98 rg 0 0 842 595 re f\n';
  stream += '0.02 0.22 0.32 RG 3 w 24 24 794 547 re S\n';
  stream += '0.00 0.47 0.51 rg 24 500 794 71 re f\n';
  stream += text('TS', 66, 519, 24, 'F2', '1 1 1', 'center');
  stream += text('TECH SYSTEMES', 102, 522, 19, 'F2', '1 1 1');
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
  certificates.forEach((certificate, index) => {
    const contentNumber = 5 + index * 2;
    const pageNumber = contentNumber + 1;
    const content = Buffer.from(certificatePage(certificate), 'latin1');
    objects.set(contentNumber, Buffer.concat([
      Buffer.from(`${contentNumber} 0 obj\n<< /Length ${content.length} >>\nstream\n`, 'latin1'),
      content,
      Buffer.from('\nendstream\nendobj\n', 'latin1')
    ]));
    objects.set(pageNumber, pdfObject(pageNumber,
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${pageWidth} ${pageHeight}] /Resources << /Font << /F1 3 0 R /F2 4 0 R >> >> /Contents ${contentNumber} 0 R >>`
    ));
    pageRefs.push(`${pageNumber} 0 R`);
  });
  objects.set(2, pdfObject(2, `<< /Type /Pages /Count ${pageRefs.length} /Kids [${pageRefs.join(' ')}] >>`));

  const maxObject = 4 + certificates.length * 2;
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
