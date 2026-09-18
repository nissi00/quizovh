(() => {
  const nativeFetch = window.fetch.bind(window);
  const instanceStorageKey = 'ts-ppt-diagnostic-instance';
  const eventStorageKey = 'ts-ppt-diagnostic-events';
  const trackedPaths = new Set([
    '/api/quality/presentation/state',
    '/api/quality/presentation/exam',
    '/api/quality/presentation/exam-review',
    '/api/improvements/presentation-state'
  ]);
  let sequenceNumber = 0;
  let flushRunning = false;

  const makeId = prefix => {
    if (window.crypto?.randomUUID) return window.crypto.randomUUID();
    return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 14)}`;
  };

  const loadInstanceId = () => {
    try {
      const existing = sessionStorage.getItem(instanceStorageKey);
      if (/^[A-Za-z0-9_-]{8,80}$/.test(existing || '')) return existing;
      const created = makeId('ppt');
      sessionStorage.setItem(instanceStorageKey, created);
      return created;
    } catch {
      return makeId('ppt');
    }
  };

  const instanceId = loadInstanceId();

  const readEvents = () => {
    try {
      const entries = JSON.parse(localStorage.getItem(eventStorageKey) || '[]');
      return Array.isArray(entries) ? entries : [];
    } catch {
      return [];
    }
  };

  const writeEvents = entries => {
    try { localStorage.setItem(eventStorageKey, JSON.stringify(entries.slice(-50))); }
    catch { /* The diagnostic must never interfere with the presentation. */ }
  };

  const queueEvent = event => writeEvents([...readEvents(), event]);

  const flushEvents = async () => {
    if (flushRunning) return;
    const pending = readEvents().slice(0, 20);
    if (!pending.length) return;
    flushRunning = true;
    try {
      const response = await nativeFetch('/api/presentation/diagnostics', {
        method:'POST',
        credentials:'same-origin',
        headers:{ 'Content-Type':'application/json' },
        body:JSON.stringify({ events:pending })
      });
      if (response.ok) {
        const sentIds = new Set(pending.map(item => item.request_id));
        writeEvents(readEvents().filter(item => !sentIds.has(item.request_id)));
      }
    } catch {
      // Keep the events locally until a later presentation request succeeds.
    } finally {
      flushRunning = false;
    }
  };

  const rewrittenInput = input => {
    if (typeof input !== 'string') return input;
    if (input.startsWith('/api/presentation/state?')) {
      return input.replace('/api/presentation/state?', '/api/quality/presentation/state?');
    }
    if (input.startsWith('/api/presentation/exam?')) {
      return input.replace('/api/presentation/exam?', '/api/quality/presentation/exam?');
    }
    return input;
  };

  const pathnameFor = input => {
    try {
      const value = typeof input === 'string' || input instanceof URL ? String(input) : input?.url;
      return value ? new URL(value, window.location.origin).pathname : '';
    } catch {
      return '';
    }
  };

  window.fetch = async (input, init = {}) => {
    const rewritten = rewrittenInput(input);
    const endpoint = pathnameFor(rewritten);
    if (!trackedPaths.has(endpoint)) return nativeFetch(rewritten, init);

    const requestId = makeId('req');
    const requestSequence = ++sequenceNumber;
    const mode = endpoint.includes('/exam') ? 'exam' : 'session';
    const startedAt = performance.now();
    const headers = new Headers(input instanceof Request ? input.headers : undefined);
    new Headers(init.headers || {}).forEach((value, name) => headers.set(name, value));
    headers.set('X-TS-PPT-Instance', instanceId);
    headers.set('X-TS-PPT-Request', requestId);
    headers.set('X-TS-PPT-Sequence', String(requestSequence));
    headers.set('X-TS-PPT-Mode', mode);

    try {
      const response = await nativeFetch(rewritten, { ...init, headers });
      const durationMs = Math.max(0, Math.round(performance.now() - startedAt));
      if (!response.ok) {
        queueEvent({
          occurred_at:new Date().toISOString(),request_id:requestId,instance_id:instanceId,
          sequence_number:requestSequence,mode,endpoint,http_status:response.status,duration_ms:durationMs,
          error_kind:response.status === 429 ? 'rate_limit' : `http_${response.status}`,
          error_message:String(response.statusText || '').slice(0, 240)
        });
      } else {
        void flushEvents();
      }
      return response;
    } catch (error) {
      queueEvent({
        occurred_at:new Date().toISOString(),request_id:requestId,instance_id:instanceId,
        sequence_number:requestSequence,mode,endpoint,http_status:null,
        duration_ms:Math.max(0, Math.round(performance.now() - startedAt)),
        error_kind:'network_error',error_message:String(error?.message || error?.name || 'Échec réseau').slice(0, 240)
      });
      throw error;
    }
  };
})();
