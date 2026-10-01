export function createSynchronizedClock({ localNow = () => Date.now() } = {}) {
  let offsetMs = 0;
  let synchronized = false;

  function markRequest() {
    return localNow();
  }

  function sample(serverNow, requestStartedAt, receivedAt = localNow()) {
    const serverMs = new Date(serverNow).getTime();
    const startedAt = Number(requestStartedAt);
    if (!Number.isFinite(serverMs) || !Number.isFinite(startedAt)) return null;
    const roundTripMs = Math.max(0, receivedAt - startedAt);
    return {
      offsetMs:serverMs - (startedAt + roundTripMs / 2),
      roundTripMs
    };
  }

  function syncBest(samples) {
    const best = (samples || [])
      .filter(item => item && Number.isFinite(item.offsetMs) && Number.isFinite(item.roundTripMs))
      .sort((left, right) => left.roundTripMs - right.roundTripMs)[0];
    if (!best) return null;
    if (!synchronized || Math.abs(best.offsetMs - offsetMs) > 1500) offsetMs = best.offsetMs;
    else offsetMs = offsetMs * 0.75 + best.offsetMs * 0.25;
    synchronized = true;
    return { ...best, appliedOffsetMs:offsetMs };
  }

  function sync(serverNow, requestStartedAt, receivedAt = localNow()) {
    return syncBest([sample(serverNow, requestStartedAt, receivedAt)]);
  }

  function now() {
    return localNow() + offsetMs;
  }

  function remainingSeconds(deadline) {
    const end = new Date(deadline).getTime();
    if (!Number.isFinite(end)) return 0;
    return Math.max(0, Math.ceil((end - now()) / 1000));
  }

  return { markRequest, sample, sync, syncBest, now, remainingSeconds, isSynchronized:() => synchronized };
}
