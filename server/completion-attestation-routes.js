import crypto from 'node:crypto';
import { pool, isUuid, httpError } from './lot-improvements-common.js';
import { createCompletionDocumentsPdf } from './completion-attestation-pdf.js';
import { zipEntry, zipFooter } from './zip-archive.js';

const maxParticipantsPerBatch = 250;
const maxSignatureBytes = 1024 * 1024;

function parseCookies(header = '') {
  return Object.fromEntries(String(header).split(';').map(part => part.trim()).filter(Boolean).map(part => {
    const index = part.indexOf('=');
    if (index < 0) return [part,''];
    try { return [part.slice(0,index),decodeURIComponent(part.slice(index + 1))]; }
    catch { return [part.slice(0,index),part.slice(index + 1)]; }
  }));
}

async function staffUser(req) {
  const token = parseCookies(req.headers.cookie).quiz_staff;
  if (!token) throw httpError(401,'Connexion instructeur requise.');
  const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
  const result = await pool.query(
    `SELECT u.id,u.first_name,u.last_name,u.role
     FROM auth_sessions s JOIN app_users u ON u.id=s.user_id
     WHERE s.token_hash=$1 AND s.kind='staff' AND s.expires_at>now()
       AND u.archived_at IS NULL AND u.role IN ('instructor','superadmin')`,
    [tokenHash]
  );
  if (!result.rows[0]) throw httpError(401,'Connexion instructeur requise.');
  return result.rows[0];
}

function safe(handler) {
  return async (req,res) => {
    try { await handler(req,res); }
    catch (error) {
      const status = Number(error?.status) || 500;
      if (status >= 500) console.error('[completion-attestations]',error);
      if (!res.headersSent) res.status(status).json({message:status >= 500 ? 'Erreur interne du serveur.' : error.message});
    }
  };
}

function optionalText(value,max = 500) {
  const normalized = String(value ?? '').trim().replace(/\s+/g,' ');
  if (normalized.length > max) throw httpError(400,'Un champ du formulaire est trop long.');
  return normalized || null;
}

function optionalMultiline(value,max = 2400) {
  const normalized = String(value ?? '').replace(/\r\n?/g,'\n').split('\n').map(line => line.trim().replace(/[ \t]+/g,' ')).join('\n').trim();
  if (normalized.length > max) throw httpError(400,'Un champ du formulaire est trop long.');
  return normalized || null;
}

function optionalDate(value,label) {
  const normalized = String(value ?? '').trim();
  if (!normalized) return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(normalized)) throw httpError(400,`${label} invalide.`);
  return normalized;
}

function imagePayload(body) {
  if (!body?.data_base64) return {data:null,mimeType:null};
  const encoded = String(body.data_base64).replace(/\s+/g,'');
  if (encoded.length > Math.ceil(maxSignatureBytes * 4 / 3) + 8 || !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) throw httpError(400,'Image de signature invalide.');
  const data = Buffer.from(encoded,'base64');
  if (!data.length || data.length > maxSignatureBytes) throw httpError(400,'La signature doit peser au maximum 1 Mo.');
  const isPng = data.length > 24 && data.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]));
  const isJpeg = data.length > 4 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff;
  if (!isPng && !isJpeg) throw httpError(400,'Utilisez une signature PNG ou JPEG valide.');
  const mimeType = isPng ? 'image/png' : 'image/jpeg';
  if (body.mime_type && body.mime_type !== mimeType) throw httpError(400,'Le type de la signature ne correspond pas à son contenu.');
  return {data,mimeType};
}

function formSnapshot(body,group) {
  const rawDuration = String(body?.duration_value ?? '').trim();
  const duration = rawDuration ? Number(rawDuration) : null;
  if (duration !== null && (!Number.isFinite(duration) || duration <= 0 || duration > 10000)) throw httpError(400,'Durée de formation invalide.');
  const unit = body?.duration_unit === 'hours' ? 'hours' : body?.duration_unit === 'days' ? 'days' : null;
  const startDate = optionalDate(body?.start_date,'Date de début');
  const endDate = optionalDate(body?.end_date,'Date de fin');
  if (startDate && endDate && endDate < startDate) throw httpError(400,'La date de fin doit être postérieure à la date de début.');
  return {
    organization_name:optionalText(body?.organization_name,200),
    organization_address:optionalMultiline(body?.organization_address,700),
    organization_siret:optionalText(body?.organization_siret,50),
    organization_vat:optionalText(body?.organization_vat,50),
    declaration_number:optionalText(body?.declaration_number,80),
    declaration_prefecture:optionalText(body?.declaration_prefecture,120),
    representative_name:optionalText(body?.representative_name,200),
    representative_title:optionalText(body?.representative_title,200),
    group_name:group.name,
    theme_name:group.theme_name,
    training_title:optionalText(body?.training_title,300),
    objective:optionalMultiline(body?.objective,2400),
    start_date:startDate,
    end_date:endDate,
    duration_value:duration === null ? null : Math.round(duration * 100) / 100,
    duration_unit:unit,
    training_location:optionalText(body?.training_location,300),
    language:optionalText(body?.language,80),
    session_number:optionalText(body?.session_number,120),
    action_nature:optionalText(body?.action_nature,120),
    attendance_details:optionalMultiline(body?.attendance_details,1600),
    evaluation_result:optionalText(body?.evaluation_result,500),
    validity_duration:optionalText(body?.validity_duration,100),
    valid_until:optionalDate(body?.valid_until,'Date de fin de validité'),
    retention_duration:optionalText(body?.retention_duration,100),
    issue_place:optionalText(body?.issue_place,200),
    issue_date:optionalDate(body?.issue_date,"Date d'émission"),
    attestation_header_text:optionalMultiline(body?.attestation_header_text,800),
    attestation_intro_text:optionalMultiline(body?.attestation_intro_text,800),
    attestation_certification_text:optionalMultiline(body?.attestation_certification_text,1000),
    attestation_compliance_text:optionalMultiline(body?.attestation_compliance_text,1400),
    attestation_result_text:optionalMultiline(body?.attestation_result_text,1000),
    attestation_rights_text:optionalMultiline(body?.attestation_rights_text,800),
    realization_intro_text:optionalMultiline(body?.realization_intro_text,1800),
    realization_training_text:optionalMultiline(body?.realization_training_text,1200),
    realization_framework_text:optionalMultiline(body?.realization_framework_text,1400),
    realization_objectives_intro_text:optionalMultiline(body?.realization_objectives_intro_text,800),
    realization_evaluation_text:optionalMultiline(body?.realization_evaluation_text,1000),
    retention_text:optionalMultiline(body?.retention_text,2400),
    signature_caption:optionalMultiline(body?.signature_caption,500)
  };
}

async function groupForUser(groupId,user,client = pool) {
  if (!isUuid(groupId)) throw httpError(400,'Groupe invalide.');
  const result = await client.query(
    `SELECT tg.*,t.name AS theme_name
     FROM training_groups tg JOIN themes t ON t.id=tg.theme_id
     WHERE tg.id=$1 AND tg.archived_at IS NULL AND ($2::boolean OR tg.instructor_id=$3)`,
    [groupId,user.role === 'superadmin',user.id]
  );
  if (!result.rows[0]) throw httpError(404,'Groupe de formation introuvable ou non autorisé.');
  return result.rows[0];
}

async function batchForUser(batchId,user,client = pool) {
  if (!isUuid(batchId)) throw httpError(400,"Lot d'attestations invalide.");
  const result = await client.query(
    `SELECT b.*
     FROM completion_attestation_batches b
     LEFT JOIN training_groups tg ON tg.id=b.group_id
     WHERE b.id=$1 AND b.archived_at IS NULL
       AND ($2::boolean OR b.created_by=$3 OR tg.instructor_id=$3)`,
    [batchId,user.role === 'superadmin',user.id]
  );
  if (!result.rows[0]) throw httpError(404,"Lot d'attestations introuvable ou non autorisé.");
  return result.rows[0];
}

async function documentsForBatch(batchId,user,attestationId = null) {
  const batch = await batchForUser(batchId,user);
  const values = attestationId ? [batchId,attestationId] : [batchId];
  const filter = attestationId ? ' AND a.id=$2' : '';
  const result = await pool.query(
    `SELECT a.id,a.attestation_number,a.participant_snapshot,b.form_snapshot,
      b.logo_data,b.logo_mime_type,b.signature_data,b.signature_mime_type,b.created_at
     FROM completion_attestations a
     JOIN completion_attestation_batches b ON b.id=a.batch_id
     WHERE a.batch_id=$1${filter}
     ORDER BY lower(a.participant_snapshot->>'last_name'),lower(a.participant_snapshot->>'first_name'),a.id`,
    values
  );
  return {batch,documents:result.rows};
}

function filePart(value,fallback = 'attestation') {
  const normalized = String(value || '').normalize('NFKD').replace(/[\u0300-\u036f]/g,'').replace(/[^A-Za-z0-9_-]+/g,'-').replace(/^-+|-+$/g,'').slice(0,80);
  return normalized || fallback;
}

function documentKinds(value) {
  const kind = String(value || 'both').toLowerCase();
  if (kind === 'attestation') return ['attestation'];
  if (kind === 'realisation') return ['realisation'];
  if (kind === 'both') return ['attestation','realisation'];
  throw httpError(400,'Type de document invalide.');
}

export function registerCompletionAttestationRoutes(app) {
  app.get('/api/completion-attestations/catalog',safe(async (req,res) => {
    const user = await staffUser(req);
    const groups = await pool.query(
      `SELECT tg.id,tg.name,tg.theme_id,t.name AS theme_name,tg.client_name,tg.start_date,tg.end_date,
        tg.location,tg.modality,tg.status,count(tgp.user_id)::integer AS participant_count
       FROM training_groups tg JOIN themes t ON t.id=tg.theme_id
       LEFT JOIN training_group_participants tgp ON tgp.group_id=tg.id
       WHERE tg.archived_at IS NULL AND ($1::boolean OR tg.instructor_id=$2)
       GROUP BY tg.id,t.name ORDER BY tg.start_date DESC,tg.created_at DESC`,
      [user.role === 'superadmin',user.id]
    );
    const themes = [...new Map(groups.rows.map(group => [group.theme_id,{id:group.theme_id,name:group.theme_name}])).values()];
    res.set('Cache-Control','no-store').json({themes,groups:groups.rows,signer:{name:`${user.first_name} ${user.last_name}`.trim()}});
  }));

  app.get('/api/completion-attestations/groups/:id',safe(async (req,res) => {
    const user = await staffUser(req);
    const group = await groupForUser(req.params.id,user);
    const participants = await pool.query(
      `SELECT u.id,u.first_name,u.last_name,u.email,u.participant_code
       FROM training_group_participants tgp JOIN app_users u ON u.id=tgp.user_id
       WHERE tgp.group_id=$1 AND u.role='learner' AND u.archived_at IS NULL
       ORDER BY lower(u.last_name),lower(u.first_name),u.id`,
      [group.id]
    );
    res.set('Cache-Control','no-store').json({group,participants:participants.rows});
  }));

  app.get('/api/completion-attestations/history',safe(async (req,res) => {
    const user = await staffUser(req);
    const groupId = String(req.query?.group_id || '');
    if (groupId && !isUuid(groupId)) throw httpError(400,'Groupe invalide.');
    const page = Math.max(1,Number.parseInt(req.query?.page,10) || 1);
    const pageSize = 10;
    const offset = (page - 1) * pageSize;
    const values = [user.role === 'superadmin',user.id,groupId || null];
    const [countResult,result] = await Promise.all([
      pool.query(
        `SELECT count(*)::integer AS total
         FROM completion_attestation_batches b
         LEFT JOIN training_groups tg ON tg.id=b.group_id
         WHERE b.archived_at IS NULL
           AND ($1::boolean OR b.created_by=$2 OR tg.instructor_id=$2)
           AND ($3::uuid IS NULL OR b.group_id=$3)`,
        values
      ),
      pool.query(
      `SELECT b.id,b.created_at,b.form_snapshot,
        count(a.id)::integer AS participant_count,
        json_agg(json_build_object(
          'id',a.id,'number',a.attestation_number,
          'first_name',a.participant_snapshot->>'first_name',
          'last_name',a.participant_snapshot->>'last_name'
        ) ORDER BY lower(a.participant_snapshot->>'last_name'),lower(a.participant_snapshot->>'first_name')) AS participants
       FROM completion_attestation_batches b
       LEFT JOIN training_groups tg ON tg.id=b.group_id
       JOIN completion_attestations a ON a.batch_id=b.id
       WHERE b.archived_at IS NULL
         AND ($1::boolean OR b.created_by=$2 OR tg.instructor_id=$2)
         AND ($3::uuid IS NULL OR b.group_id=$3)
       GROUP BY b.id
       ORDER BY b.created_at DESC
       LIMIT $4 OFFSET $5`,
        [...values,pageSize,offset]
      )
    ]);
    res.set('Cache-Control','no-store').json({
      items:result.rows,
      total:countResult.rows[0]?.total || 0,
      page,
      page_size:pageSize
    });
  }));

  app.post('/api/completion-attestations/batches',safe(async (req,res) => {
    const user = await staffUser(req);
    req.user = user;
    const participantIds = [...new Set(Array.isArray(req.body?.participant_ids) ? req.body.participant_ids.map(String) : [])];
    if (!participantIds.length) throw httpError(400,'Sélectionnez au moins un participant.');
    if (participantIds.length > maxParticipantsPerBatch || participantIds.some(id => !isUuid(id))) throw httpError(400,'Sélection de participants invalide.');
    const signature = imagePayload(req.body?.signature);
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const group = await groupForUser(req.body?.group_id,user,client);
      const snapshot = formSnapshot(req.body?.form,group);
      const participants = await client.query(
        `SELECT u.id,u.first_name,u.last_name,u.email,u.participant_code
         FROM training_group_participants tgp JOIN app_users u ON u.id=tgp.user_id
         WHERE tgp.group_id=$1 AND u.id=ANY($2::uuid[]) AND u.role='learner' AND u.archived_at IS NULL
         ORDER BY lower(u.last_name),lower(u.first_name),u.id`,
        [group.id,participantIds]
      );
      if (participants.rows.length !== participantIds.length) throw httpError(400,'Un participant sélectionné ne fait plus partie de ce groupe.');
      const logo = await client.query(
        `SELECT ba.data,ba.mime_type
         FROM organization_settings os LEFT JOIN branding_assets ba ON ba.id=os.logo_asset_id
         WHERE os.id=1`
      );
      const created = await client.query(
        `INSERT INTO completion_attestation_batches(
          group_id,created_by,template_version,form_snapshot,logo_data,logo_mime_type,signature_data,signature_mime_type
         ) VALUES($1,$2,'2026-09-v2',$3::jsonb,$4,$5,$6,$7) RETURNING id,created_at`,
        [group.id,user.id,JSON.stringify(snapshot),logo.rows[0]?.data || null,logo.rows[0]?.mime_type || null,signature.data,signature.mimeType]
      );
      for (const participant of participants.rows) {
        const number = `TS-AFF-${new Date().getUTCFullYear()}-${crypto.randomBytes(5).toString('hex').toUpperCase()}`;
        const participantSnapshot = {
          first_name:participant.first_name,last_name:participant.last_name,
          email:participant.email || null,participant_code:participant.participant_code || null
        };
        await client.query(
          `INSERT INTO completion_attestations(batch_id,user_id,attestation_number,participant_snapshot)
           VALUES($1,$2,$3,$4::jsonb)`,
          [created.rows[0].id,participant.id,number,JSON.stringify(participantSnapshot)]
        );
      }
      await client.query('COMMIT');
      res.status(201).json({id:created.rows[0].id,created_at:created.rows[0].created_at,participant_count:participants.rows.length});
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally { client.release(); }
  }));

  app.post('/api/completion-attestations/batches/:id/archive',safe(async (req,res) => {
    const user = await staffUser(req);
    req.user = user;
    const batchId = String(req.params.id || '');
    if (!isUuid(batchId)) throw httpError(400,"Lot d'attestations invalide.");
    const result = await pool.query(
      `UPDATE completion_attestation_batches b
       SET archived_at=now(),archived_by=$3
       WHERE b.id=$1 AND b.archived_at IS NULL
         AND ($2::boolean OR b.created_by=$3 OR EXISTS (
           SELECT 1 FROM training_groups tg
           WHERE tg.id=b.group_id AND tg.instructor_id=$3
         ))
       RETURNING b.id`,
      [batchId,user.role === 'superadmin',user.id]
    );
    if (!result.rows[0]) throw httpError(404,"Lot d'attestations introuvable ou non autorisé.");
    res.locals.audit = {
      action:'completion_attestation.archive',
      entityType:'completion_attestation_batch',
      entityId:batchId,
      summary:'Archivage d’un lot de documents de fin de formation'
    };
    res.status(204).end();
  }));

  app.get('/api/completion-attestations/:id.pdf',safe(async (req,res) => {
    const user = await staffUser(req);
    if (!isUuid(req.params.id)) throw httpError(400,'Attestation invalide.');
    const lookup = await pool.query('SELECT batch_id FROM completion_attestations WHERE id=$1',[req.params.id]);
    if (!lookup.rows[0]) throw httpError(404,'Attestation introuvable.');
    const {documents} = await documentsForBatch(lookup.rows[0].batch_id,user,req.params.id);
    if (!documents.length) throw httpError(404,'Attestation introuvable.');
    const participant = documents[0].participant_snapshot;
    const kinds = documentKinds(req.query?.document);
    const prefix = kinds.length === 2 ? 'documents-fin-formation' : kinds[0] === 'attestation' ? 'attestation-fin-formation' : 'certificat-realisation';
    const fileName = `${prefix}-${filePart(participant.last_name)}-${filePart(participant.first_name)}.pdf`;
    res.set({'Cache-Control':'no-store','Content-Type':'application/pdf','Content-Disposition':`attachment; filename="${fileName}"`});
    res.send(createCompletionDocumentsPdf(documents,{kinds}));
  }));

  app.get('/api/completion-attestations/batches/:id.pdf',safe(async (req,res) => {
    const user = await staffUser(req);
    const {batch,documents} = await documentsForBatch(req.params.id,user);
    if (!documents.length) throw httpError(404,"Aucune attestation dans ce lot.");
    const title = batch.form_snapshot?.training_title || 'formation';
    const kinds = documentKinds(req.query?.document);
    const prefix = kinds.length === 2 ? 'documents-fin-formation' : kinds[0] === 'attestation' ? 'attestations' : 'certificats-realisation';
    res.set({'Cache-Control':'no-store','Content-Type':'application/pdf','Content-Disposition':`attachment; filename="${prefix}-${filePart(title)}.pdf"`});
    res.send(createCompletionDocumentsPdf(documents,{kinds}));
  }));

  app.get('/api/completion-attestations/batches/:id.zip',safe(async (req,res) => {
    const user = await staffUser(req);
    const {batch,documents} = await documentsForBatch(req.params.id,user);
    if (!documents.length) throw httpError(404,"Aucune attestation dans ce lot.");
    const title = batch.form_snapshot?.training_title || 'formation';
    res.set({'Cache-Control':'no-store','Content-Type':'application/zip','Content-Disposition':`attachment; filename="documents-fin-formation-${filePart(title)}.zip"`});
    res.flushHeaders();
    const central = [];
    let offset = 0;
    for (const document of documents) {
      const participant = document.participant_snapshot;
      for (const kind of ['attestation','realisation']) {
        const prefix = kind === 'attestation' ? 'attestation-fin-formation' : 'certificat-realisation';
        const name = `${prefix}-${filePart(participant.last_name)}-${filePart(participant.first_name)}.pdf`;
        const entry = zipEntry(name,createCompletionDocumentsPdf([document],{kinds:[kind]}),offset);
        entry.localParts.forEach(part => res.write(part));
        central.push(...entry.centralParts);
        offset += entry.localLength;
      }
    }
    zipFooter(central,offset,documents.length * 2).forEach(part => res.write(part));
    res.end();
  }));
}
