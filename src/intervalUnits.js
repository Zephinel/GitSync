// Interval unit table shared by every interval-style settings control.
//
// Kept in its own module so `IntervalControl.jsx` exports only a component and
// React Fast Refresh can hot-update it instead of invalidating the module.

export const INTERVAL_UNIT_OPTIONS = Object.freeze({
  seconds: { key: 'seconds', label: '秒', factor: 1 },
  minutes: { key: 'minutes', label: '分钟', factor: 60 },
  hours: { key: 'hours', label: '小时', factor: 3600 },
})

// Rendering order of the unit row, matching the existing settings control.
export const INTERVAL_UNIT_ORDER = Object.freeze(['seconds', 'minutes', 'hours'])
