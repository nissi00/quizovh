import zlib from 'node:zlib';

const pageWidth = 595;
const pageHeight = 842;
const blue = '0.02 0.22 0.32';
const teal = '0.00 0.47 0.51';
const ink = '0.05 0.08 0.10';
const muted = '0.34 0.38 0.40';
const pdfDefaults = {
  language:'FRANÇAIS',action_nature:'Action de formation',evaluation_result:'Objectifs atteints - Oui',
  validity_duration:'4 ans',retention_duration:'3 ans',attestation_header_text:'{formation}',
  attestation_intro_text:'Je soussigné(e), {signataire},',
  attestation_certification_text:"certifie que {participant}\na suivi l’intégralité du stage :",
  attestation_compliance_text:'Formation réalisée conformément au programme et aux objectifs définis par l’organisme de formation.',
  attestation_result_text:"et a obtenu un avis « favorable » à l’issue de la validation des acquis.",
  attestation_rights_text:'délivrée pour faire valoir ce que de droit.',
  realization_intro_text:"Je soussigné(e) {signataire}, représentant(e) légal(e) du dispensateur de formation {organisme}, organisme déclaré sous le numéro d’activité {declaration} auprès du Préfet de {prefecture}, atteste que :",
  realization_training_text:"a suivi l’action de formation : {formation}",
  realization_framework_text:"dans le cadre de la formation professionnelle continue relevant de l’article L6313-1 du Code du travail.",
  realization_objectives_intro_text:'À l’issue de la formation, le stagiaire sera en capacité de :',
  realization_evaluation_text:'Avis du formateur : {evaluation_result}',
  retention_text:"Sans préjudice des délais imposés par les règles fiscales, comptables ou commerciales, l’organisme s’engage à conserver l’ensemble des pièces justificatives ayant permis d’établir le présent certificat pendant une durée de {retention_duration} à compter de la fin de l’année du dernier paiement. En cas de cofinancement par des fonds européens, la durée de conservation est étendue conformément aux obligations conventionnelles spécifiques.",
  signature_caption:'Cachet et signature\ndu responsable du dispensateur de formation'
};

function latin(value) {
  return String(value ?? '')
    .normalize('NFKC')
    .replace(/[’‘]/g,"'")
    .replace(/[“”«»]/g,'"')
    .replace(/œ/g,'oe')
    .replace(/Œ/g,'OE')
    .replace(/[–—]/g,'-')
    .replace(/[^\x20-\xFF\n]/g,'');
}

function pdfString(value) {
  return latin(value).replace(/([\\()])/g,'\\$1').replace(/\n/g,' ');
}

function estimatedWidth(value,size,font = 'F1') {
  return latin(value).length * size * (font === 'F2' ? 0.55 : font === 'F3' ? 0.49 : 0.5);
}

function text(value,x,y,size,font = 'F1',color = ink,align = 'left') {
  if (value === null || value === undefined || String(value).trim() === '') return '';
  const width = estimatedWidth(value,size,font);
  const position = align === 'center' ? x - width / 2 : align === 'right' ? x - width : x;
  return `BT /${font} ${size} Tf ${color} rg 1 0 0 1 ${position.toFixed(1)} ${y.toFixed(1)} Tm (${pdfString(value)}) Tj ET\n`;
}

function line(x1,y1,x2,y2,width = 0.7,color = '0.10 0.20 0.24') {
  return `${color} RG ${width} w ${x1} ${y1} m ${x2} ${y2} l S\n`;
}

function box(x,y,width,height,options = {}) {
  let output = '';
  if (options.fill) output += `${options.fill} rg ${x} ${y} ${width} ${height} re f\n`;
  if (options.stroke !== false) output += `${options.color || '0.12 0.20 0.24'} RG ${options.lineWidth || 0.7} w ${x} ${y} ${width} ${height} re S\n`;
  return output;
}

function wrap(value,maxChars,maxLines = 30) {
  const paragraphs = latin(value).split(/\r?\n/);
  const lines = [];
  for (const source of paragraphs) {
    const words = source.trim().split(/\s+/).filter(Boolean);
    if (!words.length) {
      if (lines.length && lines.at(-1) !== '') lines.push('');
      continue;
    }
    let current = '';
    for (const word of words) {
      const candidate = current ? `${current} ${word}` : word;
      if (candidate.length > maxChars && current) {
        lines.push(current);
        current = word;
      } else current = candidate;
      if (lines.length >= maxLines) break;
    }
    if (current && lines.length < maxLines) lines.push(current);
    if (lines.length >= maxLines) break;
  }
  return lines;
}

function paragraph(value,x,y,size,maxChars,lineHeight,options = {}) {
  if (!value) return {commands:'',nextY:y,lines:[]};
  const lines = wrap(value,maxChars,options.maxLines || 30);
  const commands = lines.map((entry,index) => text(entry,x,y - index * lineHeight,size,options.font || 'F1',options.color || ink,options.align || 'left')).join('');
  return {commands,nextY:y - lines.length * lineHeight,lines};
}

function jpegDimensions(data) {
  let offset = 2;
  while (offset + 9 < data.length) {
    if (data[offset] !== 0xff) {offset += 1;continue;}
    const marker = data[offset + 1];
    if ([0xc0,0xc1,0xc2,0xc3,0xc5,0xc6,0xc7,0xc9,0xca,0xcb,0xcd,0xce,0xcf].includes(marker)) {
      return {height:data.readUInt16BE(offset + 5),width:data.readUInt16BE(offset + 7),colorSpace:data[offset + 9] === 1 ? '/DeviceGray' : '/DeviceRGB'};
    }
    if (marker === 0xd8 || marker === 0xd9) {offset += 2;continue;}
    const length = data.readUInt16BE(offset + 2);
    if (length < 2) break;
    offset += length + 2;
  }
  throw new Error('Dimensions JPEG introuvables.');
}

function paeth(a,b,c) {
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
    if (type === 'IHDR') {width = chunk.readUInt32BE(0);height = chunk.readUInt32BE(4);bitDepth = chunk[8];colorType = chunk[9];interlace = chunk[12];}
    else if (type === 'PLTE') palette = chunk;
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
    const filter = inflated[sourceOffset++],rowOffset = row * scanline;
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
    else {const paletteIndex = pixels[source];red = palette[paletteIndex * 3] ?? 255;green = palette[paletteIndex * 3 + 1] ?? 255;blue = palette[paletteIndex * 3 + 2] ?? 255;alpha = transparency?.[paletteIndex] ?? 255;}
    if (colorType === 4) alpha = pixels[source + 1];
    if (colorType === 6) alpha = pixels[source + 3];
    const target = index * 3;
    rgb[target] = Math.round((red * alpha + 255 * (255 - alpha)) / 255);
    rgb[target + 1] = Math.round((green * alpha + 255 * (255 - alpha)) / 255);
    rgb[target + 2] = Math.round((blue * alpha + 255 * (255 - alpha)) / 255);
  }
  return {width,height,data:zlib.deflateSync(rgb),filter:'/FlateDecode',colorSpace:'/DeviceRGB'};
}

function imageData(data,mimeType) {
  if (!Buffer.isBuffer(data) || !data.length) return null;
  try {
    if (mimeType === 'image/jpeg') return {...jpegDimensions(data),data,filter:'/DCTDecode'};
    if (mimeType === 'image/png') return pngToRgb(data);
  } catch {return null;}
  return null;
}

function imageCommand(name,image,x,y,maxWidth,maxHeight) {
  const scale = Math.min(maxWidth / image.width,maxHeight / image.height);
  const width = image.width * scale,height = image.height * scale;
  return `q ${width.toFixed(2)} 0 0 ${height.toFixed(2)} ${(x + (maxWidth - width) / 2).toFixed(2)} ${(y + (maxHeight - height) / 2).toFixed(2)} cm /${name} Do Q\n`;
}

function dateLabel(value) {
  if (!value) return '';
  const date = new Date(`${String(value).slice(0,10)}T12:00:00Z`);
  return Number.isFinite(date.getTime()) ? new Intl.DateTimeFormat('fr-FR',{dateStyle:'long',timeZone:'UTC'}).format(date) : latin(value);
}

function participantName(participant) {
  return `${participant.first_name || ''} ${participant.last_name || ''}`.trim();
}

function durationLabel(form) {
  const duration = Number(form.duration_value);
  if (!Number.isFinite(duration) || duration <= 0 || !form.duration_unit) return '';
  const unit = form.duration_unit === 'hours' ? `heure${duration > 1 ? 's' : ''}` : `jour${duration > 1 ? 's' : ''}`;
  return `${String(duration).replace('.',',')} ${unit}`;
}

function periodLabel(form) {
  const start = dateLabel(form.start_date),end = dateLabel(form.end_date);
  if (start && end) return `du ${start} au ${end}`;
  if (start) return `à partir du ${start}`;
  if (end) return `jusqu’au ${end}`;
  return '';
}

function templateContext(form,participant) {
  return {
    participant:participantName(participant),formation:form.training_title || '',signataire:form.representative_name || '',
    organisme:form.organization_name || '',declaration:form.declaration_number || '',prefecture:form.declaration_prefecture || '',
    evaluation_result:form.evaluation_result || '',retention_duration:form.retention_duration || ''
  };
}

function renderTemplate(value,context) {
  const source = String(value || '').trim();
  if (!source) return '';
  const keys = [...source.matchAll(/\{([a-z_]+)\}/g)].map(match => match[1]);
  if (keys.some(key => !String(context[key] || '').trim())) return '';
  return source.replace(/\{([a-z_]+)\}/g,(_,key) => context[key] || '').replace(/[ \t]+/g,' ').replace(/ +([,.;:])/g,'$1').trim();
}

function objectiveItems(value) {
  return String(value || '').replace(/\s+-\s+(?=\S)/g,'\n- ').split(/\r?\n/).map(item => item.trim().replace(/^[-•]\s*/,'' )).filter(Boolean);
}

function attendanceRows(form) {
  const rows = String(form.attendance_details || '').split(/\r?\n/).map(lineValue => {
    const [date,...rest] = lineValue.split('|');
    return {date:String(date || '').trim(),duration:rest.join('|').trim()};
  }).filter(row => row.date || row.duration).slice(0,7);
  if (rows.length) return rows;
  const period = periodLabel(form),duration = durationLabel(form);
  return period || duration ? [{date:period,duration}] : [];
}

function attestationPage(document,logo,signature) {
  const form = {...pdfDefaults,...(document.form_snapshot || {})},participant = document.participant_snapshot || {};
  const context = templateContext(form,participant);
  const topTitle = renderTemplate(form.attestation_header_text,context);
  const intro = renderTemplate(form.attestation_intro_text,context);
  const certification = renderTemplate(form.attestation_certification_text,context);
  const compliance = renderTemplate(form.attestation_compliance_text,context);
  const result = renderTemplate(form.attestation_result_text,context);
  const rights = renderTemplate(form.attestation_rights_text,context);
  const period = periodLabel(form),duration = durationLabel(form);
  let stream = '1 1 1 rg 0 0 595 842 re f\n';

  if (logo) stream += imageCommand('Logo',logo,228,692,139,96);
  else {
    stream += '0.02 0.22 0.32 RG 1.3 w 267 716 61 61 re S\n';
    stream += text('TS',pageWidth / 2,738,24,'F2',blue,'center');
  }
  stream += text(form.organization_name || 'TS FORMATION',pageWidth / 2,676,20,'F1',blue,'center');

  const titleBlock = paragraph(topTitle,pageWidth / 2,625,12.5,72,16,{font:'F2',align:'center',maxLines:4,color:ink});
  stream += titleBlock.commands;
  let y = Math.min(565,titleBlock.nextY - 30);
  const introBlock = paragraph(intro,pageWidth / 2,y,10.5,78,14,{align:'center',maxLines:3});
  stream += introBlock.commands;y = introBlock.nextY - 22;
  const certificationBlock = paragraph(certification,pageWidth / 2,y,11,70,15,{font:'F2',align:'center',maxLines:4});
  stream += certificationBlock.commands;y = certificationBlock.nextY - 10;
  const trainingBlock = paragraph(form.training_title,pageWidth / 2,y,12,65,15,{font:'F2',align:'center',maxLines:3});
  stream += trainingBlock.commands;y = trainingBlock.nextY - 8;
  if (period || duration) {
    const details = [period,duration ? `(${duration})` : ''].filter(Boolean).join(' ');
    stream += text(details,pageWidth / 2,y,10.5,'F1',ink,'center');y -= 18;
  }
  if (form.training_location) {stream += text(`qui s’est déroulée à ${form.training_location}`,pageWidth / 2,y,10.5,'F1',ink,'center');y -= 18;}
  if (form.language) {stream += text(`en langue : ${String(form.language).toUpperCase()}`,pageWidth / 2,y,10.5,'F1',ink,'center');y -= 28;}
  const complianceBlock = paragraph(compliance,pageWidth / 2,y,9.5,84,13,{align:'center',maxLines:4});
  stream += complianceBlock.commands;

  stream += text('ATTESTATION',93,212,10.5,'F2',ink,'center');
  stream += text(`N° ${document.attestation_number}`,93,193,8.5,'F1',ink,'center');
  let rightY = 218;
  const resultBlock = paragraph(result,205,rightY,9.5,70,13,{maxLines:3});
  stream += resultBlock.commands;rightY = resultBlock.nextY - 4;
  const issue = [form.issue_place ? `Fait à ${form.issue_place}` : '',form.issue_date ? `le ${dateLabel(form.issue_date)}` : ''].filter(Boolean).join(', ');
  if (issue) {stream += text(issue,205,rightY,9.5);rightY -= 17;}
  const validity = [form.validity_duration ? `Attestation valable ${form.validity_duration}` : '',form.valid_until ? `jusqu’au ${dateLabel(form.valid_until)}` : ''].filter(Boolean).join(' ');
  if (validity) {stream += text(validity,205,rightY,9.5);rightY -= 17;}
  const rightsBlock = paragraph(rights,205,rightY,9.5,66,13,{maxLines:3});
  stream += rightsBlock.commands;
  stream += text('Signature :',212,105,9.5,'F1',ink);
  if (signature) stream += imageCommand('Signature',signature,270,66,118,63);
  else stream += line(278,78,384,78,0.6,'0.45 0.45 0.45');
  stream += text(form.representative_name || '',430,103,9,'F2',ink,'center');
  stream += text(form.representative_title || '',430,89,8,'F3',muted,'center');
  return stream;
}

function actionNatureBox(form,y) {
  const options = ['Action de formation','Bilan de compétences','Action de VAE','Action de formation par apprentissage'];
  let stream = box(42,y - 58,511,58,{color:'0.10 0.10 0.10'});
  stream += box(42,y - 58,165,58,{fill:'0.92 0.92 0.92',color:'0.10 0.10 0.10'});
  stream += paragraph('Nature de l’action concourant au développement des compétences :',52,y - 14,8.5,29,11,{maxLines:4}).commands;
  options.forEach((item,index) => {
    const rowY = y - 13 - index * 12;
    stream += box(218,rowY - 3,7,7,{stroke:true,color:'0.20 0.20 0.20',lineWidth:0.6});
    if (form.action_nature === item) {
      stream += line(219,rowY,221,rowY - 2,1.1,blue);
      stream += line(221,rowY - 2,225,rowY + 4,1.1,blue);
    }
    stream += text(item,231,rowY - 2,8.3,'F1',ink);
  });
  return stream;
}

function attendanceTable(form,y) {
  const rows = attendanceRows(form);
  if (!rows.length) return {commands:'',nextY:y};
  const rowHeight = 17,totalHeight = rowHeight * (rows.length + 1);
  let stream = box(42,y - totalHeight,511,totalHeight,{color:'0.12 0.12 0.12'});
  stream += box(42,y - rowHeight,511,rowHeight,{fill:'0.92 0.92 0.92',color:'0.12 0.12 0.12'});
  stream += line(315,y,315,y - totalHeight,0.7,'0.12 0.12 0.12');
  stream += text('Dates',178,y - 12,8.5,'F2',ink,'center');
  stream += text('Durées de présence',434,y - 12,8.5,'F2',ink,'center');
  rows.forEach((row,index) => {
    const top = y - rowHeight * (index + 1);
    stream += line(42,top,553,top,0.5,'0.25 0.25 0.25');
    stream += text(row.date,178,top - 12,8.5,'F1',ink,'center');
    stream += text(row.duration,434,top - 12,8.5,'F1',ink,'center');
  });
  return {commands:stream,nextY:y - totalHeight};
}

function objectivesBox(form,y) {
  const items = objectiveItems(form.objective).slice(0,8);
  const intro = form.realization_objectives_intro_text || '';
  if (!items.length && !intro) return {commands:'',nextY:y};
  const height = Math.max(92,32 + items.reduce((sum,item) => sum + Math.max(1,wrap(item,70,3).length) * 11,0));
  const safeHeight = Math.min(height,150);
  let stream = box(42,y - safeHeight,511,safeHeight,{color:'0.12 0.12 0.12'});
  stream += box(42,y - safeHeight,170,safeHeight,{fill:'0.92 0.92 0.92',color:'0.12 0.12 0.12'});
  stream += text('Rappel des objectifs',52,y - 24,9,'F2',ink);
  stream += paragraph(intro,52,y - 39,8,27,10,{maxLines:6}).commands;
  let itemY = y - 22;
  for (const item of items) {
    const lines = wrap(item,65,3);
    stream += `${teal} rg 226 ${itemY - 2} 4 4 re f\n`;
    lines.forEach((entry,index) => {stream += text(entry,238,itemY - index * 11,8.2,'F1',ink);});
    itemY -= Math.max(1,lines.length) * 11 + 2;
    if (itemY < y - safeHeight + 10) break;
  }
  return {commands:stream,nextY:y - safeHeight};
}

function realizationPage(document,logo,signature) {
  const form = {...pdfDefaults,...(document.form_snapshot || {})},participant = document.participant_snapshot || {};
  const context = templateContext(form,participant);
  const intro = renderTemplate(form.realization_intro_text,context);
  const training = renderTemplate(form.realization_training_text,context);
  const framework = renderTemplate(form.realization_framework_text,context);
  const evaluation = renderTemplate(form.realization_evaluation_text,context);
  const retention = renderTemplate(form.retention_text,context);
  let stream = '1 1 1 rg 0 0 595 842 re f\n';
  if (logo) stream += imageCommand('Logo',logo,477,756,76,52);
  else stream += text('TS',515,780,20,'F2',blue,'center');
  stream += text(form.organization_name || 'TS FORMATION',42,787,9.5,'F2',blue);
  stream += text('CERTIFICAT DE RÉALISATION',pageWidth / 2,750,18,'F2','0.10 0.22 0.50','center');

  let y = 724;
  const introBlock = paragraph(intro,42,y,8.9,112,11,{maxLines:5});
  stream += introBlock.commands;y = introBlock.nextY - 8;
  const personName = participantName(document.participant_snapshot || {});
  if (personName) {stream += text(personName,pageWidth / 2,y,10,'F2',ink,'center');y -= 18;}
  const trainingBlock = paragraph(training,42,y,9,108,12,{font:'F2',maxLines:4});
  stream += trainingBlock.commands;y = trainingBlock.nextY - 2;
  const frameworkBlock = paragraph(framework,42,y,8.7,112,11,{maxLines:3});
  stream += frameworkBlock.commands;y = frameworkBlock.nextY - 8;
  stream += actionNatureBox(form,y);y -= 67;

  const period = periodLabel(form),duration = durationLabel(form);
  const session = form.session_number ? `N° de session : ${form.session_number}` : '';
  const periodLine = [period,session,duration ? `durée totale prévue de ${duration}` : ''].filter(Boolean).join(' / ');
  if (periodLine) {stream += paragraph(periodLine,42,y,8.6,112,11,{maxLines:2}).commands;y -= 25;}
  const attendance = attendanceTable(form,y);
  stream += attendance.commands;y = attendance.nextY - 7;
  const objectives = objectivesBox(form,y);
  stream += objectives.commands;y = objectives.nextY - 7;

  if (evaluation) {
    const height = 31;
    stream += box(42,y - height,511,height,{color:'0.12 0.12 0.12'});
    stream += box(42,y - height,170,height,{fill:'0.92 0.92 0.92',color:'0.12 0.12 0.12'});
    stream += text('Résultat de l’évaluation des acquis',51,y - 19,8.5,'F2',ink);
    stream += paragraph(evaluation,222,y - 19,8.5,66,10,{maxLines:2}).commands;
    y -= height + 7;
  }
  const retentionBlock = paragraph(retention,42,y,6.9,142,8.5,{maxLines:6,color:'0.18 0.18 0.18'});
  stream += retentionBlock.commands;y = retentionBlock.nextY - 12;

  const issue = [form.issue_place ? `Fait à : ${form.issue_place}` : '',form.issue_date ? `Le : ${dateLabel(form.issue_date)}` : ''].filter(Boolean);
  issue.forEach((entry,index) => {stream += text(entry,58,Math.max(115,y) - index * 14,8.7,'F1',ink);});
  const signatureY = 95;
  stream += box(342,signatureY,211,80,{color:'0.10 0.22 0.50'});
  const caption = paragraph(form.signature_caption,447,159,8.2,48,10,{align:'center',maxLines:3});
  stream += caption.commands;
  if (signature) stream += imageCommand('Signature',signature,382,101,130,46);
  else stream += text('Signature',447,113,7.5,'F3',muted,'center');

  stream += line(42,62,553,62,0.8,'0.65 0.70 0.72');
  stream += text(form.organization_name || 'TS Formation',42,46,8,'F2',blue);
  const address = wrap(form.organization_address || '',88,2);
  address.forEach((entry,index) => {stream += text(entry,42,35 - index * 9,6.8,'F1',ink);});
  const legal = [form.organization_siret ? `SIRET ${form.organization_siret}` : '',form.organization_vat ? `TVA ${form.organization_vat}` : ''].filter(Boolean).join(' - ');
  stream += text(legal,42,17,6.8,'F1',ink);
  stream += text(`N° ${document.attestation_number}`,553,31,7,'F3',ink,'right');
  stream += text('Page 1 sur 1',553,18,7,'F3',ink,'right');
  return stream;
}

function pdfObject(number,body) {
  return Buffer.from(`${number} 0 obj\n${body}\nendobj\n`,'latin1');
}

function imageObject(number,image) {
  return Buffer.concat([
    Buffer.from(`${number} 0 obj\n<< /Type /XObject /Subtype /Image /Width ${image.width} /Height ${image.height} /ColorSpace ${image.colorSpace} /BitsPerComponent 8 /Filter ${image.filter} /Length ${image.data.length} >>\nstream\n`,'latin1'),
    image.data,
    Buffer.from('\nendstream\nendobj\n','latin1')
  ]);
}

export function createCompletionDocumentsPdf(documents,options = {}) {
  if (!Array.isArray(documents) || !documents.length) throw new Error('Aucun document à générer.');
  const kinds = Array.isArray(options.kinds) && options.kinds.length ? options.kinds : ['attestation','realisation'];
  if (kinds.some(kind => !['attestation','realisation'].includes(kind))) throw new Error('Type de document invalide.');
  const first = documents[0];
  const logo = imageData(first.logo_data,first.logo_mime_type);
  const signature = imageData(first.signature_data,first.signature_mime_type);
  const objects = new Map(),pageRefs = [];
  objects.set(1,pdfObject(1,'<< /Type /Catalog /Pages 2 0 R >>'));
  objects.set(3,pdfObject(3,'<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>'));
  objects.set(4,pdfObject(4,'<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>'));
  objects.set(5,pdfObject(5,'<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Oblique /Encoding /WinAnsiEncoding >>'));
  let nextObject = 6,logoNumber = null,signatureNumber = null;
  if (logo) {logoNumber = nextObject++;objects.set(logoNumber,imageObject(logoNumber,logo));}
  if (signature) {signatureNumber = nextObject++;objects.set(signatureNumber,imageObject(signatureNumber,signature));}
  for (const document of documents) {
    for (const kind of kinds) {
      const contentNumber = nextObject++,pageNumber = nextObject++;
      const pageStream = kind === 'attestation' ? attestationPage(document,logo,signature) : realizationPage(document,logo,signature);
      const content = Buffer.from(pageStream,'latin1');
      objects.set(contentNumber,Buffer.concat([
        Buffer.from(`${contentNumber} 0 obj\n<< /Length ${content.length} >>\nstream\n`,'latin1'),content,Buffer.from('\nendstream\nendobj\n','latin1')
      ]));
      const xObjects = [logoNumber ? `/Logo ${logoNumber} 0 R` : '',signatureNumber ? `/Signature ${signatureNumber} 0 R` : ''].filter(Boolean).join(' ');
      objects.set(pageNumber,pdfObject(pageNumber,`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${pageWidth} ${pageHeight}] /Resources << /Font << /F1 3 0 R /F2 4 0 R /F3 5 0 R >>${xObjects ? ` /XObject << ${xObjects} >>` : ''} >> /Contents ${contentNumber} 0 R >>`));
      pageRefs.push(`${pageNumber} 0 R`);
    }
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

export function createCompletionAttestationsPdf(documents) {
  return createCompletionDocumentsPdf(documents,{kinds:['attestation']});
}
