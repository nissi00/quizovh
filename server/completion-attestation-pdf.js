import zlib from 'node:zlib';

const pageWidth = 595;
const pageHeight = 842;

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

function estimatedWidth(value, size, font = 'F1') {
  return latin(value).length * size * (font === 'F2' ? 0.55 : font === 'F3' ? 0.49 : 0.5);
}

function text(value, x, y, size, font = 'F1', color = '0.03 0.18 0.28', align = 'left') {
  const width = estimatedWidth(value, size, font);
  const position = align === 'center' ? x - width / 2 : align === 'right' ? x - width : x;
  return `BT /${font} ${size} Tf ${color} rg 1 0 0 1 ${position.toFixed(1)} ${y.toFixed(1)} Tm (${pdfString(value)}) Tj ET\n`;
}

function wrap(value, maxChars, maxLines = 20) {
  const paragraphs = latin(value).split(/\r?\n/);
  const lines = [];
  for (const paragraph of paragraphs) {
    const words = paragraph.trim().split(/\s+/).filter(Boolean);
    if (!words.length) {
      if (lines.length) lines.push('');
      continue;
    }
    let line = '';
    for (const word of words) {
      const candidate = line ? `${line} ${word}` : word;
      if (candidate.length > maxChars && line) {
        lines.push(line);
        line = word;
      } else line = candidate;
      if (lines.length >= maxLines) break;
    }
    if (line && lines.length < maxLines) lines.push(line);
    if (lines.length >= maxLines) break;
  }
  return lines;
}

function paragraph(value, x, y, size, maxChars, lineHeight, options = {}) {
  const lines = wrap(value, maxChars, options.maxLines || 20);
  const commands = lines.map((line, index) => text(line, x, y - index * lineHeight, size, options.font || 'F1', options.color, options.align)).join('');
  return { commands, nextY:y - lines.length * lineHeight, lines };
}

function jpegDimensions(data) {
  let offset = 2;
  while (offset + 9 < data.length) {
    if (data[offset] !== 0xff) { offset += 1; continue; }
    const marker = data[offset + 1];
    if ([0xc0,0xc1,0xc2,0xc3,0xc5,0xc6,0xc7,0xc9,0xca,0xcb,0xcd,0xce,0xcf].includes(marker)) {
      return { height:data.readUInt16BE(offset + 5),width:data.readUInt16BE(offset + 7),colorSpace:data[offset + 9] === 1 ? '/DeviceGray' : '/DeviceRGB' };
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
  const pa = Math.abs(p - a),pb = Math.abs(p - b),pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
}

function pngToRgb(data) {
  if (!data.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) throw new Error('PNG invalide.');
  let offset = 8,width = 0,height = 0,bitDepth = 0,colorType = 0,interlace = 0;
  let palette = null,transparency = null;
  const compressed = [];
  while (offset + 12 <= data.length) {
    const length = data.readUInt32BE(offset);
    const type = data.toString('ascii',offset + 4,offset + 8);
    const chunk = data.subarray(offset + 8,offset + 8 + length);
    if (type === 'IHDR') {
      width = chunk.readUInt32BE(0);height = chunk.readUInt32BE(4);bitDepth = chunk[8];colorType = chunk[9];interlace = chunk[12];
    } else if (type === 'PLTE') palette = chunk;
    else if (type === 'tRNS') transparency = chunk;
    else if (type === 'IDAT') compressed.push(chunk);
    else if (type === 'IEND') break;
    offset += length + 12;
  }
  const channels = ({0:1,2:3,3:1,4:2,6:4})[colorType];
  if (!width || !height || bitDepth !== 8 || interlace !== 0 || !channels || !compressed.length) throw new Error('Format PNG non pris en charge.');
  if (colorType === 3 && !palette) throw new Error('Palette PNG absente.');
  const scanline = width * channels;
  const inflated = zlib.inflateSync(Buffer.concat(compressed));
  if (inflated.length < height * (scanline + 1)) throw new Error('Données PNG incomplètes.');
  const pixels = Buffer.alloc(height * scanline);
  let sourceOffset = 0;
  for (let row = 0;row < height;row += 1) {
    const filter = inflated[sourceOffset++];
    const rowOffset = row * scanline;
    for (let column = 0;column < scanline;column += 1) {
      const raw = inflated[sourceOffset++];
      const left = column >= channels ? pixels[rowOffset + column - channels] : 0;
      const up = row ? pixels[rowOffset + column - scanline] : 0;
      const upperLeft = row && column >= channels ? pixels[rowOffset + column - scanline - channels] : 0;
      let value = raw;
      if (filter === 1) value = raw + left;
      else if (filter === 2) value = raw + up;
      else if (filter === 3) value = raw + Math.floor((left + up) / 2);
      else if (filter === 4) value = raw + paeth(left,up,upperLeft);
      else if (filter !== 0) throw new Error('Filtre PNG inconnu.');
      pixels[rowOffset + column] = value & 0xff;
    }
  }
  const rgb = Buffer.alloc(width * height * 3);
  for (let index = 0;index < width * height;index += 1) {
    const source = index * channels;
    let red,green,blue,alpha = 255;
    if (colorType === 0 || colorType === 4) red = green = blue = pixels[source];
    else if (colorType === 2 || colorType === 6) {red = pixels[source];green = pixels[source + 1];blue = pixels[source + 2];}
    else {
      const paletteIndex = pixels[source];
      red = palette[paletteIndex * 3] ?? 255;green = palette[paletteIndex * 3 + 1] ?? 255;blue = palette[paletteIndex * 3 + 2] ?? 255;
      alpha = transparency?.[paletteIndex] ?? 255;
    }
    if (colorType === 4) alpha = pixels[source + 1];
    if (colorType === 6) alpha = pixels[source + 3];
    const target = index * 3;
    rgb[target] = Math.round((red * alpha + 255 * (255 - alpha)) / 255);
    rgb[target + 1] = Math.round((green * alpha + 255 * (255 - alpha)) / 255);
    rgb[target + 2] = Math.round((blue * alpha + 255 * (255 - alpha)) / 255);
  }
  return {width,height,data:zlib.deflateSync(rgb),filter:'/FlateDecode',colorSpace:'/DeviceRGB'};
}

function imageData(data, mimeType) {
  if (!Buffer.isBuffer(data) || !data.length) return null;
  try {
    if (mimeType === 'image/jpeg') return {...jpegDimensions(data),data,filter:'/DCTDecode'};
    if (mimeType === 'image/png') return pngToRgb(data);
  } catch {
    return null;
  }
  return null;
}

function imageCommand(name, image, x, y, maxWidth, maxHeight) {
  const scale = Math.min(maxWidth / image.width,maxHeight / image.height);
  const width = image.width * scale,height = image.height * scale;
  return `q ${width.toFixed(2)} 0 0 ${height.toFixed(2)} ${(x + (maxWidth - width) / 2).toFixed(2)} ${(y + (maxHeight - height) / 2).toFixed(2)} cm /${name} Do Q\n`;
}

function dateLabel(value) {
  const date = new Date(`${String(value).slice(0,10)}T12:00:00Z`);
  return Number.isFinite(date.getTime()) ? new Intl.DateTimeFormat('fr-FR',{dateStyle:'long',timeZone:'UTC'}).format(date) : latin(value);
}

function attestationPage(attestation, logo, signature) {
  const form = attestation.form_snapshot || {};
  const participant = attestation.participant_snapshot || {};
  const duration = Number(form.duration_value || 0);
  const durationUnit = form.duration_unit === 'hours' ? `heure${duration > 1 ? 's' : ''}` : `jour${duration > 1 ? 's' : ''}`;
  let stream = '';
  stream += '1 1 1 rg 0 0 595 842 re f\n';
  stream += '0.02 0.22 0.32 RG 1.5 w 28 28 539 786 re S\n';
  stream += '0.00 0.47 0.51 rg 28 790 539 24 re f\n';
  if (logo) stream += imageCommand('Logo',logo,48,724,116,62);
  else stream += text('TS',106,747,30,'F2','0.00 0.47 0.51','center');

  let leftY = 716;
  for (const line of wrap(form.organization_name || 'Organisme de formation',38,2)) {
    stream += text(line,48,leftY,11,'F2');leftY -= 14;
  }
  for (const line of wrap(form.organization_address || '',42,4)) {
    stream += text(line,48,leftY,9,'F1','0.28 0.34 0.37');leftY -= 12;
  }
  if (form.organization_siret) {stream += text(`SIRET : ${form.organization_siret}`,48,leftY,8.5,'F1','0.28 0.34 0.37');leftY -= 11;}
  if (form.declaration_number) stream += text(`Déclaration d'activité : ${form.declaration_number}`,48,leftY,8.5,'F1','0.28 0.34 0.37');

  let rightY = 766;
  if (form.client_name) {stream += text(form.client_name,345,rightY,11,'F2');rightY -= 15;}
  for (const line of wrap(form.client_address || '',31,5)) {
    stream += text(line,345,rightY,9.5,'F1','0.28 0.34 0.37');rightY -= 13;
  }

  stream += '0.89 0.98 0.95 rg 47 623 501 36 re f\n';
  stream += text('ATTESTATION DE FIN DE FORMATION',pageWidth / 2,635,17,'F2','0.02 0.22 0.32','center');
  stream += paragraph(`Je soussigné(e) ${form.representative_name}, ${form.representative_title}, représentant(e) de ${form.organization_name}, atteste que :`,48,596,10.5,92,14,{maxLines:3}).commands;
  stream += text(`${participant.first_name || ''} ${participant.last_name || ''}`.trim(),pageWidth / 2,535,20,'F2','0.02 0.22 0.32','center');
  if (participant.email) stream += text(participant.email,pageWidth / 2,517,9.5,'F1','0.28 0.34 0.37','center');
  stream += text('a suivi la formation intitulée :',48,484,10.5,'F1','0.03 0.18 0.28');
  const titleBlock = paragraph(form.training_title,48,463,14,67,17,{font:'F2',color:'0.00 0.47 0.51',maxLines:2});
  stream += titleBlock.commands;
  stream += text("Objectif de la formation :",48,418,10.5,'F2');
  const objectiveBlock = paragraph(form.objective,62,400,9.5,91,12,{maxLines:6,color:'0.15 0.22 0.25'});
  stream += objectiveBlock.commands;
  stream += text(`Dates de formation : du ${dateLabel(form.start_date)} au ${dateLabel(form.end_date)}`,48,315,10,'F2');
  stream += text(`Durée totale : ${String(duration).replace('.',',')} ${durationUnit}`,48,294,10,'F1');
  if (form.training_location) stream += text(`Lieu ou modalité : ${form.training_location}`,48,273,10,'F1');

  const evidence = [];
  if (form.evidence_attendance) evidence.push('Attestation ou feuille de présence');
  if (form.evidence_assessment) evidence.push('Évaluation des acquis');
  if (form.evidence_satisfaction) evidence.push('Enquête de satisfaction');
  if (evidence.length) {
    stream += text('La participation à la formation peut être justifiée par :',48,240,10,'F2');
    evidence.forEach((item,index) => {
      stream += '0.00 0.47 0.51 rg 55 ' + String(218 - index * 20) + ' 5 5 re f\n';
      stream += text(item,69,215 - index * 20,9.5,'F1','0.15 0.22 0.25');
    });
  }

  stream += text(`Fait à ${form.issue_place}, le ${dateLabel(form.issue_date)}`,48,130,10,'F1');
  stream += text(form.representative_name,430,147,10,'F2','0.03 0.18 0.28','center');
  stream += text(form.representative_title,430,132,9,'F3','0.28 0.34 0.37','center');
  if (signature) stream += imageCommand('Signature',signature,365,61,130,63);
  else {
    stream += '0.55 0.62 0.64 RG 0.7 w 374 84 112 0 re S\n';
    stream += text('Signature',430,70,8,'F1','0.45 0.50 0.52','center');
  }
  stream += text(`N° ${attestation.attestation_number}`,48,55,8.5,'F2','0.02 0.22 0.32');
  stream += text('Attestation individuelle générée par TS Formation.',pageWidth / 2,41,7.5,'F1','0.42 0.47 0.49','center');
  return stream;
}

function pdfObject(number, body) {
  return Buffer.from(`${number} 0 obj\n${body}\nendobj\n`,'latin1');
}

function imageObject(number, image) {
  return Buffer.concat([
    Buffer.from(`${number} 0 obj\n<< /Type /XObject /Subtype /Image /Width ${image.width} /Height ${image.height} /ColorSpace ${image.colorSpace} /BitsPerComponent 8 /Filter ${image.filter} /Length ${image.data.length} >>\nstream\n`,'latin1'),
    image.data,
    Buffer.from('\nendstream\nendobj\n','latin1')
  ]);
}

export function createCompletionAttestationsPdf(attestations) {
  if (!Array.isArray(attestations) || !attestations.length) throw new Error('Aucune attestation à générer.');
  const first = attestations[0];
  const logo = imageData(first.logo_data,first.logo_mime_type);
  const signature = imageData(first.signature_data,first.signature_mime_type);
  const objects = new Map();
  const pageRefs = [];
  objects.set(1,pdfObject(1,'<< /Type /Catalog /Pages 2 0 R >>'));
  objects.set(3,pdfObject(3,'<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>'));
  objects.set(4,pdfObject(4,'<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>'));
  objects.set(5,pdfObject(5,'<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Oblique /Encoding /WinAnsiEncoding >>'));
  let nextObject = 6;
  let logoNumber = null,signatureNumber = null;
  if (logo) {logoNumber = nextObject++;objects.set(logoNumber,imageObject(logoNumber,logo));}
  if (signature) {signatureNumber = nextObject++;objects.set(signatureNumber,imageObject(signatureNumber,signature));}
  for (const attestation of attestations) {
    const contentNumber = nextObject++,pageNumber = nextObject++;
    const content = Buffer.from(attestationPage(attestation,logo,signature),'latin1');
    objects.set(contentNumber,Buffer.concat([
      Buffer.from(`${contentNumber} 0 obj\n<< /Length ${content.length} >>\nstream\n`,'latin1'),content,Buffer.from('\nendstream\nendobj\n','latin1')
    ]));
    const xObjects = [logoNumber ? `/Logo ${logoNumber} 0 R` : '',signatureNumber ? `/Signature ${signatureNumber} 0 R` : ''].filter(Boolean).join(' ');
    objects.set(pageNumber,pdfObject(pageNumber,`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${pageWidth} ${pageHeight}] /Resources << /Font << /F1 3 0 R /F2 4 0 R /F3 5 0 R >>${xObjects ? ` /XObject << ${xObjects} >>` : ''} >> /Contents ${contentNumber} 0 R >>`));
    pageRefs.push(`${pageNumber} 0 R`);
  }
  objects.set(2,pdfObject(2,`<< /Type /Pages /Count ${pageRefs.length} /Kids [${pageRefs.join(' ')}] >>`));
  const maxObject = nextObject - 1;
  const header = Buffer.from('%PDF-1.4\n%\xE2\xE3\xCF\xD3\n','latin1');
  const chunks = [header],offsets = [0];
  let offset = header.length;
  for (let number = 1;number <= maxObject;number += 1) {
    const object = objects.get(number);offsets[number] = offset;chunks.push(object);offset += object.length;
  }
  const xrefOffset = offset;
  let xref = `xref\n0 ${maxObject + 1}\n0000000000 65535 f \n`;
  for (let number = 1;number <= maxObject;number += 1) xref += `${String(offsets[number]).padStart(10,'0')} 00000 n \n`;
  xref += `trailer\n<< /Size ${maxObject + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  chunks.push(Buffer.from(xref,'latin1'));
  return Buffer.concat(chunks);
}
