export function createSynchronizedClock() {
  let offsetMs = 0;
  let synchronized = false;

  function markRequest() {
    return Date.now();
  }

  function sync(serverNow, requestStartedAt = Date.now()) {
    const serverMs = new Date(serverNow).getTime();
    if (!Number.isFinite(serverMs)) return;
    const receivedAt = Date.now();
    const midpoint = requestStartedAt + Math.max(0, receivedAt - requestStartedAt) / 2;
    const candidate = serverMs - midpoint;
    if (!synchronized || Math.abs(candidate - offsetMs) > 1500) offsetMs = candidate;
    else offsetMs = offsetMs * 0.7 + candidate * 0.3;
    synchronized = true;
  }

  function now() {
    return Date.now() + offsetMs;
  }

  function remainingSeconds(deadline) {
    const end = new Date(deadline).getTime();
    if (!Number.isFinite(end)) return 0;
    return Math.max(0, Math.ceil((end - now()) / 1000));
  }

  return { markRequest, sync, now, remainingSeconds };
}
