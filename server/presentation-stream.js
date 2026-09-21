import { rateLimit } from 'express-rate-limit';
import { pool } from './lot-improvements-common.js';

const STREAM_HEARTBEAT_MS = 20_000;
const STREAM_RECONCILE_MS = 5_000;
const EXPIRATION_CHECK_MS = 1_000;
const CODE_PATTERN = /^[A-Z0-9]{4,8}$/;

const streamLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 1000,
  standardHeaders: 'draft-8',
  legacyHeaders: false
});

const signatureFor = state => {
  const comparable = { ...state };
  delete comparable.server_now;
  return JSON.stringify(comparable);
};

export function registerPresentationStreamRoutes(app, { presentationState, closeExpiredQuestions }) {
  const channels = new Map();
  const pendingRefreshes = new Map();
  let listener = null;
  let reconnectTimer = null;
  let listenerRetryMs = 2_000;
  let expirationRunning = false;
  let lastExpirationErrorAt = 0;

  const scheduleListenerReconnect = () => {
    clearTimeout(reconnectTimer);
    reconnectTimer = setTimeout(() => { void connectListener(); }, listenerRetryMs);
    reconnectTimer.unref?.();
    listenerRetryMs = Math.min(30_000, listenerRetryMs * 2);
  };

  const subscribersFor = code => {
    if (!channels.has(code)) channels.set(code, {
      subscribers:new Set(), signature:'', state:null, refreshing:false, refreshAgain:false
    });
    return channels.get(code);
  };

  const writeEvent = (res, event, payload) => {
    if (res.writableEnded || res.destroyed) return false;
    res.write(`event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`);
    return true;
  };

  const refreshCode = async (code, { force = false } = {}) => {
    const channel = channels.get(code);
    if (!channel?.subscribers.size) return;
    if (channel.refreshing) {
      channel.refreshAgain = true;
      return;
    }
    channel.refreshing = true;
    try {
      const state = await presentationState(code);
      const signature = signatureFor(state);
      if (!force && signature === channel.signature) return;
      channel.signature = signature;
      channel.state = state;
      for (const res of [...channel.subscribers]) {
        if (!writeEvent(res, 'state', state)) channel.subscribers.delete(res);
      }
    } catch (error) {
      const status = Number(error?.status) || 500;
      const payload = { status, message:status >= 500 ? 'État PowerPoint temporairement indisponible.' : error.message };
      for (const res of [...channel.subscribers]) {
        if (!writeEvent(res, 'unavailable', payload)) channel.subscribers.delete(res);
      }
    } finally {
      channel.refreshing = false;
      if (channel.refreshAgain) {
        channel.refreshAgain = false;
        scheduleRefresh(code);
      }
    }
    if (!channel.subscribers.size) channels.delete(code);
  };

  const scheduleRefresh = code => {
    const normalized = String(code || '').trim().toUpperCase();
    if (!CODE_PATTERN.test(normalized) || !channels.has(normalized)) return;
    clearTimeout(pendingRefreshes.get(normalized));
    pendingRefreshes.set(normalized, setTimeout(() => {
      pendingRefreshes.delete(normalized);
      void refreshCode(normalized);
    }, 25));
  };

  const connectListener = async () => {
    if (listener) return;
    clearTimeout(reconnectTimer);
    let client = null;
    try {
      client = await pool.connect();
      listener = client;
      await client.query('LISTEN powerpoint_presentation_state');
      listenerRetryMs = 2_000;
      client.on('notification', event => scheduleRefresh(event.payload));
      client.on('error', error => {
        console.error('[powerpoint-stream] PostgreSQL listener error', error.message);
        if (listener === client) listener = null;
        client.release(true);
        scheduleListenerReconnect();
      });
      client.on('end', () => {
        if (listener !== client) return;
        listener = null;
        scheduleListenerReconnect();
      });
    } catch (error) {
      listener = null;
      client?.release(true);
      console.error('[powerpoint-stream] PostgreSQL listener unavailable', error.message);
      scheduleListenerReconnect();
    }
  };

  const heartbeat = setInterval(() => {
    for (const [code, channel] of channels) {
      for (const res of [...channel.subscribers]) {
        if (res.writableEnded || res.destroyed) channel.subscribers.delete(res);
        else res.write(': heartbeat\n\n');
      }
      if (!channel.subscribers.size) channels.delete(code);
    }
  }, STREAM_HEARTBEAT_MS);
  heartbeat.unref?.();

  const reconcile = setInterval(() => {
    for (const code of channels.keys()) void refreshCode(code);
  }, STREAM_RECONCILE_MS);
  reconcile.unref?.();

  const expirationTimer = setInterval(async () => {
    if (expirationRunning) return;
    expirationRunning = true;
    try { await closeExpiredQuestions(); }
    catch (error) {
      if (Date.now() - lastExpirationErrorAt >= 60_000) {
        lastExpirationErrorAt = Date.now();
        console.error('[powerpoint-stream] expiration check failed', error.message);
      }
    }
    finally { expirationRunning = false; }
  }, EXPIRATION_CHECK_MS);
  expirationTimer.unref?.();

  void connectListener();

  app.get('/api/quality/presentation/stream', streamLimiter, async (req, res) => {
    const code = String(req.query?.code || '').trim().toUpperCase();
    if (!CODE_PATTERN.test(code)) return res.status(400).json({ message:'Code de session invalide.' });

    let initialState;
    try { initialState = await presentationState(code); }
    catch (error) {
      const status = Number(error?.status) || 500;
      const message = status >= 500 ? 'Erreur interne du serveur.' : error.message;
      return res.status(status).json({ message });
    }

    res.status(200);
    res.set({
      'Content-Type':'text/event-stream; charset=utf-8',
      'Cache-Control':'no-cache, no-transform',
      Connection:'keep-alive',
      'X-Accel-Buffering':'no'
    });
    res.flushHeaders?.();
    res.write('retry: 2000\n\n');

    const channel = subscribersFor(code);
    channel.subscribers.add(res);
    const initialSignature = signatureFor(initialState);
    const stateChanged = channel.signature && channel.signature !== initialSignature;
    channel.signature = initialSignature;
    channel.state = initialState;
    if (stateChanged) {
      for (const subscriber of [...channel.subscribers]) {
        if (!writeEvent(subscriber, 'state', initialState)) channel.subscribers.delete(subscriber);
      }
    } else writeEvent(res, 'state', initialState);

    req.on('close', () => {
      channel.subscribers.delete(res);
      if (!channel.subscribers.size) channels.delete(code);
    });
  });
}
