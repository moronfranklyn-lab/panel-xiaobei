'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { advanceWalk, walkFrameIndex } = require('../renderer/pet-motion');

test('walk acceleration increases speed without exceeding the requested maximum', () => {
  const next = advanceWalk({ speed: 0, maxSpeed: 60, remaining: 200, acceleration: 120, delta: 0.1 });
  assert.equal(next.speed, 12);
  assert.ok(Math.abs(next.distance - 1.2) < Number.EPSILON * 2);
});

test('walk braking lands on the target without overshooting', () => {
  const next = advanceWalk({ speed: 30, maxSpeed: 60, remaining: 1, acceleration: 120, delta: 0.1 });
  assert.equal(next.distance, 1);
  assert.ok(next.speed < 30);
});

test('walk frames follow travelled distance and wrap at a full stride', () => {
  assert.equal(walkFrameIndex(0, 48, 16), 0);
  assert.equal(walkFrameIndex(24, 48, 16), 8);
  assert.equal(walkFrameIndex(48, 48, 16), 0);
});
