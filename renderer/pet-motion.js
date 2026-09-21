'use strict';

(function exposePetMotion(globalScope) {
  function approach(value, target, amount) {
    if (value < target) return Math.min(target, value + amount);
    return Math.max(target, value - amount);
  }

  function advanceWalk(options) {
    const speed = Math.max(0, Number(options.speed) || 0);
    const maxSpeed = Math.max(0, Number(options.maxSpeed) || 0);
    const remaining = Math.max(0, Number(options.remaining) || 0);
    const acceleration = Math.max(1, Number(options.acceleration) || 1);
    const delta = Math.max(0, Number(options.delta) || 0);
    const brakingLimit = Math.sqrt(2 * acceleration * remaining);
    const desiredSpeed = Math.min(maxSpeed, brakingLimit);
    const nextSpeed = approach(speed, desiredSpeed, acceleration * delta);
    return {
      speed: nextSpeed,
      distance: Math.min(remaining, nextSpeed * delta),
    };
  }

  function walkFrameIndex(distance, stride, frameCount) {
    const frames = Math.max(1, Math.floor(Number(frameCount) || 1));
    const cycle = Math.max(1, Number(stride) || 1);
    const progress = Math.max(0, Number(distance) || 0) / cycle;
    return Math.floor(progress * frames) % frames;
  }

  const api = { advanceWalk, walkFrameIndex };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  globalScope.PetMotion = api;
})(typeof window !== 'undefined' ? window : globalThis);
