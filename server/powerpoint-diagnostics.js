import crypto from 'node:crypto';

const RETENTION_DAYS = 7;
const FLUSH_INTERVAL_MS = 30_000;
const trackedPaths = new Set([
  '/api/quality/presentation/state',
  '/api/quality/presentation/exam',
  '/api/quality/presentation/exam-review',
  '/api/improvements/presentation-state'
]);

const cleanId = (value, fallback) => {
  const normalized = String(value || '').trim();
  return /^[A-Za-z0-9_-]{8,80}$/.test(normalized) ? normalized : fallback;
};

const cleanText = (value, maximum = 240) => String(value || '').trim().slice(0, maximum);
const asInteger = (value, minimum, maximum, fallback = null) => {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= minimum && parsed <= maximum ? parsed : fallback;
};

export function createPowerpointDiagnostics({ pool, salt = '' }) {
  let metrics = new Map();
  let flushRunning = false;
  let lastCleanupAt = 0;

  const hashIp = req => crypto
    .createHmac('sha256', salt || 'ts-powerpoint-diagnostics')
    .update(String(req.ip || 'unknown'))
    .digest('hex')
    .slice(0, 16);

  const endpointFor = req => String(req.originalUrl || req.url || '').split('?')[0];

  function addMetric(item) {
    const minute = new Date(Math.floor(Date.now() / 60_000) * 60_000).toISOString();
    const key = [minute, item.instanceId, item.ipHash, item.endpoint, item.status].join('|');
    const current = metrics.get(key) || {
      minute,
      instanceId:item.instanceId,
      ipHash:item.ipHash,
      endpoint:item.endpoint,
      status:item.status,
      requestCount:0,
      durationTotalMs:0,
      durationMaxMs:0
    };
    current.requestCount += 1;
    current.durationTotalMs += item.durationMs;
    current.durationMaxMs = Math.max(current.durationMaxMs, item.durationMs);
    metrics.set(key, current);
  }

  async function saveEvent(event) {
    await pool.query(
      `INSERT INTO powerpoint_diagnostic_events(
         occurred_at,request_id,instance_id,sequence_number,mode,endpoint,source,
         http_status,duration_ms,error_kind,error_message,ip_hash
       ) VALUES(
         COALESCE($1::timestamptz,now()),$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12
       ) ON CONFLICT(source,request_id) DO NOTHING`,
      [
        event.occurredAt || null,event.requestId,event.instanceId,event.sequenceNumber,
        event.mode,event.endpoint,event.source,event.httpStatus,event.durationMs,
        event.errorKind,event.errorMessage,event.ipHash
      ]
    );
  }

  async function cleanupIfNeeded() {
    if (Date.now() - lastCleanupAt < 60 * 60 * 1000) return;
    lastCleanupAt = Date.now();
    await Promise.all([
      pool.query(`DELETE FROM powerpoint_request_metrics WHERE minute < now() - interval '${RETENTION_DAYS} days'`),
      pool.query(`DELETE FROM powerpoint_diagnostic_events WHERE received_at < now() - interval '${RETENTION_DAYS} days'`)
    ]);
  }

  async function flushMetrics() {
    if (flushRunning || !metrics.size) return;
    flushRunning = true;
    const pending = metrics;
    metrics = new Map();
    try {
      for (const item of pending.values()) {
        await pool.query(
          `INSERT INTO powerpoint_request_metrics(
             minute,instance_id,ip_hash,endpoint,http_status,request_count,duration_total_ms,duration_max_ms
           ) VALUES($1,$2,$3,$4,$5,$6,$7,$8)
           ON CONFLICT(minute,instance_id,ip_hash,endpoint,http_status) DO UPDATE SET
             request_count=powerpoint_request_metrics.request_count+EXCLUDED.request_count,
             duration_total_ms=powerpoint_request_metrics.duration_total_ms+EXCLUDED.duration_total_ms,
             duration_max_ms=GREATEST(powerpoint_request_metrics.duration_max_ms,EXCLUDED.duration_max_ms)`,
          [item.minute,item.instanceId,item.ipHash,item.endpoint,item.status,item.requestCount,item.durationTotalMs,item.durationMaxMs]
        );
      }
      await cleanupIfNeeded();
    } catch (error) {
      for (const [key, item] of pending) {
        const current = metrics.get(key);
        if (!current) metrics.set(key, item);
        else {
          current.requestCount += item.requestCount;
          current.durationTotalMs += item.durationTotalMs;
          current.durationMaxMs = Math.max(current.durationMaxMs, item.durationMaxMs);
        }
      }
      console.error('[powerpoint-diagnostics] metric flush failed', error.message);
    } finally {
      flushRunning = false;
    }
  }

  const timer = setInterval(() => { void flushMetrics(); }, FLUSH_INTERVAL_MS);
  timer.unref?.();

  function middleware(req, res, next) {
    const endpoint = endpointFor(req);
    if (!trackedPaths.has(endpoint)) return next();

    const startedAt = Date.now();
    const requestId = cleanId(req.get('x-ts-ppt-request'), crypto.randomUUID());
    const instanceId = cleanId(req.get('x-ts-ppt-instance'), 'non-identifiee');
    const sequenceNumber = asInteger(req.get('x-ts-ppt-sequence'), 0, Number.MAX_SAFE_INTEGER);
    const mode = ['session','exam'].includes(req.get('x-ts-ppt-mode')) ? req.get('x-ts-ppt-mode') : 'inconnu';
    const ipHash = hashIp(req);

    res.set('X-TS-Request-ID', requestId);
    res.on('finish', () => {
      const durationMs = Math.max(0, Date.now() - startedAt);
      addMetric({ instanceId, ipHash, endpoint, status:res.statusCode, durationMs });
      if (res.statusCode >= 400) {
        void saveEvent({
          occurredAt:new Date().toISOString(),requestId,instanceId,sequenceNumber,mode,endpoint,
          source:'server',httpStatus:res.statusCode,durationMs,
          errorKind:res.statusCode === 429 ? 'rate_limit' : `http_${res.statusCode}`,
          errorMessage:null,ipHash
        }).catch(error => console.error('[powerpoint-diagnostics] event save failed', error.message));
      }
    });
    next();
  }

  async function ingestClientEvents(req) {
    const entries = Array.isArray(req.body?.events) ? req.body.events.slice(0, 20) : [];
    const ipHash = hashIp(req);
    let accepted = 0;
    for (const entry of entries) {
      const requestId = cleanId(entry?.request_id, '');
      const instanceId = cleanId(entry?.instance_id, 'non-identifiee');
      if (!requestId) continue;
      const parsedOccurredAt = new Date(entry?.occurred_at).getTime();
      const now = Date.now();
      const occurredAt = Number.isFinite(parsedOccurredAt) && parsedOccurredAt >= now - RETENTION_DAYS * 86_400_000 && parsedOccurredAt <= now + 300_000
        ? new Date(parsedOccurredAt).toISOString()
        : new Date(now).toISOString();
      const endpoint = cleanText(entry?.endpoint, 160);
      if (!trackedPaths.has(endpoint)) continue;
      await saveEvent({
        occurredAt,requestId,instanceId,
        sequenceNumber:asInteger(entry?.sequence_number,0,Number.MAX_SAFE_INTEGER),
        mode:['session','exam'].includes(entry?.mode) ? entry.mode : 'inconnu',
        endpoint,source:'client',
        httpStatus:asInteger(entry?.http_status,100,599),
        durationMs:asInteger(entry?.duration_ms,0,600_000),
        errorKind:cleanText(entry?.error_kind,60) || 'client_error',
        errorMessage:cleanText(entry?.error_message,240) || null,
        ipHash
      });
      accepted += 1;
    }
    return { accepted };
  }

  async function report(hoursValue) {
    await flushMetrics();
    await cleanupIfNeeded();
    const hours = asInteger(hoursValue, 1, 168, 24);
    const values = [hours];
    const [overview, sources, events, timeline, endpoints, evidence] = await Promise.all([
      pool.query(
        `WITH selected AS (
           SELECT * FROM powerpoint_request_metrics WHERE minute >= now()-($1::text||' hours')::interval
         ), per_minute AS (
           SELECT minute,sum(request_count)::integer AS request_count FROM selected GROUP BY minute
         )
         SELECT
           COALESCE((SELECT sum(request_count) FROM selected),0)::integer AS request_count,
           COALESCE((SELECT sum(request_count) FROM selected WHERE http_status>=400),0)::integer AS error_count,
           COALESCE((SELECT sum(request_count) FROM selected WHERE http_status=429),0)::integer AS rate_limit_count,
           COALESCE((SELECT max(request_count) FROM per_minute),0)::integer AS maximum_requests_per_minute,
           COALESCE((SELECT count(DISTINCT instance_id) FROM selected WHERE instance_id<>'non-identifiee'),0)::integer AS identified_instance_count,
           COALESCE((SELECT count(DISTINCT ip_hash) FROM selected),0)::integer AS source_count,
           COALESCE((SELECT sum(request_count) FROM selected WHERE instance_id='non-identifiee'),0)::integer AS unidentified_request_count,
           (SELECT max(minute) FROM selected) AS last_request_at`,
        values
      ),
      pool.query(
        `SELECT instance_id,ip_hash,sum(request_count)::integer AS request_count,
          COALESCE(sum(request_count) FILTER (WHERE http_status>=400),0)::integer AS error_count,
          max(duration_max_ms)::integer AS maximum_duration_ms,max(minute) AS last_seen_at
         FROM powerpoint_request_metrics
         WHERE minute >= now()-($1::text||' hours')::interval
         GROUP BY instance_id,ip_hash
         ORDER BY request_count DESC,last_seen_at DESC LIMIT 100`,
        values
      ),
      pool.query(
        `SELECT occurred_at,received_at,request_id,instance_id,sequence_number,mode,endpoint,source,
          http_status,duration_ms,error_kind,error_message,ip_hash
         FROM powerpoint_diagnostic_events
         WHERE occurred_at >= now()-($1::text||' hours')::interval
         ORDER BY occurred_at DESC,received_at DESC LIMIT 200`,
        values
      ),
      pool.query(
        `SELECT minute,sum(request_count)::integer AS request_count,
          COALESCE(sum(request_count) FILTER (WHERE http_status>=400),0)::integer AS error_count,
          COALESCE(sum(request_count) FILTER (WHERE http_status=429),0)::integer AS rate_limit_count
         FROM powerpoint_request_metrics
         WHERE minute >= now()-($1::text||' hours')::interval
         GROUP BY minute ORDER BY minute DESC LIMIT 180`,
        values
      ),
      pool.query(
        `SELECT endpoint,sum(request_count)::integer AS request_count,
          COALESCE(sum(request_count) FILTER (WHERE http_status>=400),0)::integer AS error_count,
          COALESCE(sum(request_count) FILTER (WHERE http_status=429),0)::integer AS rate_limit_count,
          CASE WHEN sum(request_count)>0 THEN round(sum(duration_total_ms)::numeric/sum(request_count))::integer ELSE 0 END AS average_duration_ms,
          max(duration_max_ms)::integer AS maximum_duration_ms
         FROM powerpoint_request_metrics
         WHERE minute >= now()-($1::text||' hours')::interval
         GROUP BY endpoint ORDER BY request_count DESC`,
        values
      ),
      pool.query(
        `SELECT
          count(*) FILTER (WHERE event.source='client' AND event.error_kind='network_error')::integer AS network_error_count,
          count(*) FILTER (WHERE event.source='server' AND event.http_status>=500)::integer AS server_error_count,
          count(*) FILTER (
            WHERE event.source='client' AND event.http_status IN (502,503,504)
              AND NOT EXISTS (
                SELECT 1 FROM powerpoint_diagnostic_events server_event
                WHERE server_event.source='server' AND server_event.request_id=event.request_id
              )
          )::integer AS proxy_error_count
         FROM powerpoint_diagnostic_events event
         WHERE event.occurred_at >= now()-($1::text||' hours')::interval`,
        values
      )
    ]);
    return {
      hours,overview:overview.rows[0],sources:sources.rows,events:events.rows,
      timeline:timeline.rows.reverse(),endpoints:endpoints.rows,evidence:evidence.rows[0]
    };
  }

  return { middleware, ingestClientEvents, report, flushMetrics };
}
