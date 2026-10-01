import test from 'node:test';
import assert from 'node:assert/strict';
import { createSynchronizedClock } from '../synchronized-clock.js';

test('la meilleure mesure réseau fixe l’horloge commune', () => {
  let now = 10_000;
  const clock = createSynchronizedClock({ localNow:() => now });
  const slow = clock.sample(new Date(15_150).toISOString(),10_000,10_300);
  const fast = clock.sample(new Date(15_020).toISOString(),10_000,10_040);
  const result = clock.syncBest([slow,fast]);

  assert.equal(result.roundTripMs,40);
  assert.equal(clock.now(),15_000);
});

test('le temps restant est calculé depuis l’échéance serveur', () => {
  let now = 20_000;
  const clock = createSynchronizedClock({ localNow:() => now });
  clock.sync(new Date(25_000).toISOString(),20_000,20_000);

  assert.equal(clock.remainingSeconds(new Date(30_001).toISOString()),6);
  now += 1_001;
  assert.equal(clock.remainingSeconds(new Date(30_001).toISOString()),4);
});
