// easing.js — the single tiny easing helper allowed by the constraints.
// v1 does not use easing for feel (deliberately plain); v2 uses these for
// launch/return settles, ammo ticks, and outcome reads. Pure functions, no lib.
export const linear = (t) => t;
export const clamp01 = (t) => (t < 0 ? 0 : t > 1 ? 1 : t);

// Eased decelerations for "lands and settles" motion (launch onto belt, etc.).
export const easeOutCubic = (t) => 1 - Math.pow(1 - t, 3);
// Eased acceleration. Used (as easeInCubic(1 - p)) for the per-shot recoil: the
// kick snaps outward fast then cushions softly back to rest within the cadence.
export const easeInCubic = (t) => t * t * t;
export const easeOutQuart = (t) => 1 - Math.pow(1 - t, 4);
// Symmetric ease for travel that starts and ends gently.
export const easeInOutCubic = (t) =>
  t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
// Overshoot-and-settle for the slot "park" snap (reads as a deliberate settle).
export const easeOutBack = (t, s = 1.70158) =>
  1 + (s + 1) * Math.pow(t - 1, 3) + s * Math.pow(t - 1, 2);
