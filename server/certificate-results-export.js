import { zipFiles } from './zip-archive.js';

const xmlEscape = value => String(value ?? '')
  .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
  .replace(/"/g,'&quot;').replace(/'/g,'&apos;');

const columnName = index => {
  let value = index + 1,result = '';
  while (value > 0) {
    const remainder = (value - 1) % 26;
    result = String.fromCharCode(65 + remainder) + result;
    value = Math.floor((value - 1) / 26);
  }
  return result;
};

function worksheetXml(rows,{ freezeHeader = false } = {}) {
  const normalized = Array.isArray(rows) ? rows : [];
  const columnCount = normalized.reduce((max,row) => Math.max(max,Array.isArray(row) ? row.length : 0),0);
  const widths = Array.from({length:columnCount},(_,columnIndex) => {
    const longest = normalized.reduce((max,row) => Math.max(max,String(Array.isArray(row) ? row[columnIndex] ?? '' : '').length),0);
    return Math.min(55,Math.max(10,longest + 2));
  });
  const cols = widths.length ? `<cols>${widths.map((width,index) => `<col min="${index + 1}" max="${index + 1}" width="${width}" customWidth="1"/>`).join('')}</cols>` : '';
  const sheetViews = freezeHeader ? '<sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>' : '';
  const sheetRows = normalized.map((row,rowIndex) => {
    const cells = (Array.isArray(row) ? row : []).map((value,columnIndex) => {
      const ref = `${columnName(columnIndex)}${rowIndex + 1}`,style = rowIndex === 0 ? ' s="1"' : '';
      if (typeof value === 'number' && Number.isFinite(value)) return `<c r="${ref}"${style}><v>${value}</v></c>`;
      return `<c r="${ref}" t="inlineStr"${style}><is><t xml:space="preserve">${xmlEscape(value ?? '')}</t></is></c>`;
    }).join('');
    return `<row r="${rowIndex + 1}">${cells}</row>`;
  }).join('');
  const filter = normalized.length > 1 && columnCount ? `<autoFilter ref="A1:${columnName(columnCount - 1)}${normalized.length}"/>` : '';
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">${sheetViews}${cols}<sheetData>${sheetRows}</sheetData>${filter}</worksheet>`;
}

function xlsxBuffer(sheets) {
  const sheetOverrides = sheets.map((_,index) => `<Override PartName="/xl/worksheets/sheet${index + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('');
  const contentTypes = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>${sheetOverrides}</Types>`;
  const rootRels = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>';
  const workbookSheets = sheets.map((sheet,index) => `<sheet name="${xmlEscape(sheet.name)}" sheetId="${index + 1}" r:id="rId${index + 1}"/>`).join('');
  const workbook = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>${workbookSheets}</sheets></workbook>`;
  const workbookRelationships = sheets.map((_,index) => `<Relationship Id="rId${index + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${index + 1}.xml"/>`).join('');
  const workbookRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${workbookRelationships}<Relationship Id="rId${sheets.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`;
  const styles = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><color rgb="FFFFFFFF"/><sz val="11"/><name val="Calibri"/></font></fonts><fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FF075B7A"/><bgColor indexed="64"/></patternFill></fill></fills><borders count="1"><border/></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="2"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="1" borderId="0" xfId="0" applyFont="1" applyFill="1"/></cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>';
  return zipFiles([
    {name:'[Content_Types].xml',data:Buffer.from(contentTypes)},
    {name:'_rels/.rels',data:Buffer.from(rootRels)},
    {name:'xl/workbook.xml',data:Buffer.from(workbook)},
    {name:'xl/_rels/workbook.xml.rels',data:Buffer.from(workbookRels)},
    {name:'xl/styles.xml',data:Buffer.from(styles)},
    ...sheets.map((sheet,index) => ({name:`xl/worksheets/sheet${index + 1}.xml`,data:Buffer.from(worksheetXml(sheet.rows,sheet.options))}))
  ]);
}

const rounded = value => Math.round(Number(value || 0) * 100) / 100;
const percent = value => `${String(rounded(value)).replace('.',',')} %`;
const resultCell = (value,{ taken = true,manual = false } = {}) => `${percent(value)}${taken ? '' : ' · absent'}${manual ? ' · modifié' : ''}`;
const certificateStatus = value => ({issued:'Délivré',outdated:'À régénérer',revoked:'Révoqué'}[value] || 'Non délivré');

function resultRows(results) {
  const quizzes = results.quizzes || [];
  const header = ['Nom','Prénom','Code participant',...quizzes.map(quiz => quiz.chapter_title || quiz.title || 'Quiz'),'Moyenne quiz','Pratique','Examen Expérience','Note Expérience','Examen final','Score global','Décision','Statut du certificat','Commentaire'];
  const rows = (results.participants || []).map(participant => [
    participant.last_name || '',participant.first_name || '',participant.participant_code || '',
    ...(participant.quiz_scores || []).map(quiz => resultCell(quiz.score,{taken:quiz.taken,manual:Boolean(quiz.manual_override)})),
    percent(participant.quiz_score),
    resultCell(participant.practice_score,{taken:Boolean(participant.experience_count) || Boolean(participant.practice_manual_override),manual:Boolean(participant.practice_manual_override)}),
    resultCell(participant.experience_exam_score,{taken:Boolean(participant.experience_exam_submitted),manual:Boolean(participant.experience_exam_manual_override)}),
    percent(participant.experience_score),
    resultCell(participant.exam_score,{taken:Boolean(participant.exam_submitted),manual:Boolean(participant.exam_manual_override)}),
    percent(participant.global_score),participant.eligible ? 'Éligible' : 'Non éligible',certificateStatus(participant.certificate?.status),participant.comment || ''
  ]);
  return [header,...rows];
}

export function createTrainingResultsXlsx(results,{ generatedAt = new Date() } = {}) {
  const policy = results.policy || {},group = results.group || {};
  const summary = [
    ['Champ','Valeur'],['Groupe',group.name || ''],['Thème',group.theme_name || ''],['Seuil de réussite',percent(group.passing_score)],
    ['Date de génération',new Intl.DateTimeFormat('fr-FR',{dateStyle:'short',timeStyle:'short',timeZone:'Europe/Paris'}).format(generatedAt)],
    ['Quiz standards',policy.include_quizzes ? `${percent(policy.quiz_weight)} du score global` : 'Non inclus'],
    ['Examen final',policy.include_exam ? `${percent(policy.exam_weight)} du score global` : 'Non inclus'],
    ['Expérience',policy.include_experience ? `${percent(policy.experience_weight)} du score global` : 'Non incluse']
  ];
  return xlsxBuffer([
    {name:'Synthèse',rows:summary,options:{freezeHeader:true}},
    {name:'Résultats',rows:resultRows(results),options:{freezeHeader:true}}
  ]);
}

const pageWidth = 842,pageHeight = 595,margin = 28,ink = '0.10 0.15 0.18',blue = '0.03 0.36 0.48',light = '0.92 0.96 0.97';
const latin = value => String(value ?? '').normalize('NFC').replace(/[–—]/g,'-').replace(/[‘’]/g,"'").replace(/[“”]/g,'"').replace(/[^\x20-\xFF]/g,'?');
const pdfEscape = value => latin(value).replace(/\\/g,'\\\\').replace(/\(/g,'\\(').replace(/\)/g,'\\)');
const text = (value,x,y,size = 8,font = 'F1',color = ink) => `BT /${font} ${size} Tf ${color} rg 1 0 0 1 ${x.toFixed(1)} ${y.toFixed(1)} Tm (${pdfEscape(value)}) Tj ET\n`;
const line = (x1,y1,x2,y2,width = .5,color = '0.70 0.75 0.77') => `${color} RG ${width} w ${x1} ${y1} m ${x2} ${y2} l S\n`;
const box = (x,y,width,height,fill = null) => `${fill ? `${fill} rg ${x} ${y} ${width} ${height} re f\n` : ''}0.70 0.75 0.77 RG .5 w ${x} ${y} ${width} ${height} re S\n`;

function clipText(value,maxChars) {
  const normalized = latin(value);
  return normalized.length <= maxChars ? normalized : `${normalized.slice(0,Math.max(1,maxChars - 3))}...`;
}

function wrap(value,maxChars) {
  const words = latin(value).replace(/\s+/g,' ').trim().split(' ').filter(Boolean),lines = [];
  let current = '';
  for (const word of words) {
    if (!current) current = word;
    else if (`${current} ${word}`.length <= maxChars) current += ` ${word}`;
    else { lines.push(current);current = word; }
  }
  if (current) lines.push(current);
  return lines.length ? lines : [''];
}

function tablePage(results,{ title,legend = [],columns,rows,pageNumber }) {
  const group = results.group || {};
  let stream = '1 1 1 rg 0 0 842 595 re f\n';
  stream += text('RÉSULTATS DE FORMATION',margin,557,15,'F2',blue);
  stream += text(`${group.name || ''} · ${group.theme_name || ''}`,margin,538,10,'F2',ink);
  stream += text(`Seuil : ${percent(group.passing_score)} · Page ${pageNumber}`,680,557,8,'F1',ink);
  stream += text(title,margin,514,11,'F2',blue);
  let y = 497;
  for (const entry of legend) { stream += text(entry,margin,y,7.2,'F1',ink);y -= 11; }
  const headerHeight = 28,rowHeight = 22,tableTop = y - 4,totalWidth = columns.reduce((sum,column) => sum + column.width,0);
  stream += box(margin,tableTop - headerHeight,totalWidth,headerHeight,light);
  let x = margin;
  columns.forEach(column => {
    stream += line(x,tableTop,x,tableTop - headerHeight - rows.length * rowHeight);
    stream += text(clipText(column.label,column.maxChars || 16),x + 4,tableTop - 18,7.1,'F2',ink);
    x += column.width;
  });
  stream += line(x,tableTop,x,tableTop - headerHeight - rows.length * rowHeight);
  rows.forEach((row,rowIndex) => {
    const top = tableTop - headerHeight - rowIndex * rowHeight;
    stream += line(margin,top,margin + totalWidth,top);
    let cellX = margin;
    row.forEach((value,columnIndex) => {
      const column = columns[columnIndex];
      stream += text(clipText(value,column.cellChars || column.maxChars || 18),cellX + 4,top - 14,7.2,columnIndex === 0 ? 'F2' : 'F1',ink);
      cellX += column.width;
    });
  });
  stream += line(margin,tableTop - headerHeight - rows.length * rowHeight,margin + totalWidth,tableTop - headerHeight - rows.length * rowHeight);
  return stream;
}

function commentPages(results,startPage) {
  const pages = [];
  let stream = '',y = 0,pageNumber = startPage;
  const start = () => {
    const group = results.group || {};
    stream = '1 1 1 rg 0 0 842 595 re f\n';
    stream += text('RÉSULTATS DE FORMATION',margin,557,15,'F2',blue);
    stream += text(`${group.name || ''} · ${group.theme_name || ''}`,margin,538,10,'F2',ink);
    stream += text(`Commentaires · Page ${pageNumber}`,680,557,8,'F1',ink);
    stream += text('Commentaires des participants',margin,512,11,'F2',blue);
    y = 488;
  };
  const finish = () => { pages.push(stream);pageNumber += 1; };
  start();
  for (const participant of results.participants || []) {
    const heading = `${participant.first_name || ''} ${participant.last_name || ''} · ${participant.participant_code || ''}`.trim();
    const lines = wrap(participant.comment || 'Aucun commentaire.',112);
    if (y - (lines.length * 11 + 28) < 42) { finish();start(); }
    stream += box(margin,y - lines.length * 11 - 18,786,lines.length * 11 + 18,'0.97 0.98 0.98');
    stream += text(heading,margin + 8,y - 13,8.2,'F2',ink);
    lines.forEach((entry,index) => { stream += text(entry,margin + 8,y - 27 - index * 11,7.7,'F1',ink); });
    y -= lines.length * 11 + 26;
  }
  finish();
  return pages;
}

function pdfObject(number,body) { return Buffer.from(`${number} 0 obj\n${body}\nendobj\n`,'latin1'); }

function makePdf(pageStreams) {
  const objects = new Map(),pageRefs = [];
  objects.set(1,pdfObject(1,'<< /Type /Catalog /Pages 2 0 R >>'));
  objects.set(3,pdfObject(3,'<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>'));
  objects.set(4,pdfObject(4,'<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>'));
  let nextObject = 5;
  for (const pageStream of pageStreams) {
    const contentNumber = nextObject++,pageNumber = nextObject++,content = Buffer.from(pageStream,'latin1');
    objects.set(contentNumber,Buffer.concat([Buffer.from(`${contentNumber} 0 obj\n<< /Length ${content.length} >>\nstream\n`,'latin1'),content,Buffer.from('\nendstream\nendobj\n','latin1')]));
    objects.set(pageNumber,pdfObject(pageNumber,`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${pageWidth} ${pageHeight}] /Resources << /Font << /F1 3 0 R /F2 4 0 R >> >> /Contents ${contentNumber} 0 R >>`));
    pageRefs.push(`${pageNumber} 0 R`);
  }
  objects.set(2,pdfObject(2,`<< /Type /Pages /Count ${pageRefs.length} /Kids [${pageRefs.join(' ')}] >>`));
  const header = Buffer.from('%PDF-1.4\n%\xE2\xE3\xCF\xD3\n','latin1'),chunks = [header],offsets = [0];
  let offset = header.length;
  for (let number = 1;number < nextObject;number += 1) { const object = objects.get(number);offsets[number] = offset;chunks.push(object);offset += object.length; }
  const xrefOffset = offset;
  let xref = `xref\n0 ${nextObject}\n0000000000 65535 f \n`;
  for (let number = 1;number < nextObject;number += 1) xref += `${String(offsets[number]).padStart(10,'0')} 00000 n \n`;
  xref += `trailer\n<< /Size ${nextObject} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  chunks.push(Buffer.from(xref,'latin1'));
  return Buffer.concat(chunks);
}

export function createTrainingResultsPdf(results) {
  const participants = results.participants || [],quizzes = results.quizzes || [],pages = [];
  let pageNumber = 1;
  const quizChunks = [];
  for (let index = 0;index < quizzes.length;index += 5) quizChunks.push({quizzes:quizzes.slice(index,index + 5),offset:index});
  if (!quizChunks.length) quizChunks.push({quizzes:[],offset:0});
  for (const chunk of quizChunks) {
    const columns = [{label:'Apprenant',width:145,cellChars:27},{label:'Code',width:72,cellChars:12},...chunk.quizzes.map((_,index) => ({label:`Évaluation ${chunk.offset + index + 1}`,width:(569 / Math.max(1,chunk.quizzes.length)),cellChars:20}))];
    const legend = chunk.quizzes.map((quiz,index) => `${chunk.offset + index + 1}. ${quiz.chapter_title || quiz.title || 'Quiz'}`);
    for (let start = 0;start < Math.max(1,participants.length);start += 15) {
      const slice = participants.slice(start,start + 15);
      const rows = slice.map(participant => [
        `${participant.first_name || ''} ${participant.last_name || ''}`.trim(),participant.participant_code || '',
        ...(participant.quiz_scores || []).slice(chunk.offset,chunk.offset + chunk.quizzes.length).map(quiz => resultCell(quiz.score,{taken:quiz.taken,manual:Boolean(quiz.manual_override)}))
      ]);
      pages.push(tablePage(results,{title:`Quiz standards · évaluations ${chunk.offset + 1} à ${chunk.offset + chunk.quizzes.length || 0}`,legend,columns,rows,pageNumber:pageNumber++}));
      if (!participants.length) break;
    }
  }
  const summaryColumns = [
    {label:'Apprenant',width:128,cellChars:23},{label:'Code',width:58,cellChars:10},{label:'Moy. quiz',width:62,cellChars:12},
    {label:'Pratique',width:70,cellChars:14},{label:'Exam. Exp.',width:76,cellChars:14},{label:'Note Exp.',width:62,cellChars:12},
    {label:'Exam. final',width:76,cellChars:14},{label:'Global',width:58,cellChars:11},{label:'Décision',width:72,cellChars:13},{label:'Certificat',width:82,cellChars:14}
  ];
  for (let start = 0;start < Math.max(1,participants.length);start += 17) {
    const rows = participants.slice(start,start + 17).map(participant => [
      `${participant.first_name || ''} ${participant.last_name || ''}`.trim(),participant.participant_code || '',percent(participant.quiz_score),
      resultCell(participant.practice_score,{taken:Boolean(participant.experience_count) || Boolean(participant.practice_manual_override),manual:Boolean(participant.practice_manual_override)}),
      resultCell(participant.experience_exam_score,{taken:Boolean(participant.experience_exam_submitted),manual:Boolean(participant.experience_exam_manual_override)}),
      percent(participant.experience_score),resultCell(participant.exam_score,{taken:Boolean(participant.exam_submitted),manual:Boolean(participant.exam_manual_override)}),
      percent(participant.global_score),participant.eligible ? 'Éligible' : 'Non éligible',certificateStatus(participant.certificate?.status)
    ]);
    pages.push(tablePage(results,{title:'Synthèse des résultats',columns:summaryColumns,rows,pageNumber:pageNumber++}));
    if (!participants.length) break;
  }
  pages.push(...commentPages(results,pageNumber));
  return makePdf(pages);
}
