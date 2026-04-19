//! Rolling-rate helper for counter-style metrics.
//!
//! Some metrics (notably `vt.full_redraw_frequency`) are useful as a
//! per-unit-of-time rate rather than a cumulative count. The rate
//! trending to zero is the health signal we care about; the raw
//! counter is monotonic and doesn't expose that trend without two
//! reads.
//!
//! `RollingRate` implements a tiny fixed-window ring: you call
//! [`RollingRate::observe`] whenever the underlying counter ticks, and
//! [`RollingRate::rate_per_second`] reports the rate averaged over the
//! last `window`. The implementation is deliberately minimal — the
//! point is to give a single consumer (the telemetry dashboard) a
//! stable number without pulling in an external rolling-window crate.
//!
//! Not thread-safe by itself; wrap in `Mutex` or a per-thread cell if
//! shared. The call sites currently keep it single-threaded (the
//! reducer task owns it).

use std::collections::VecDeque;
use std::time::{Duration, Instant};

/// Rolling per-second rate over a sliding window. Stores event
/// timestamps; oldest entries age out on each observe / rate read.
#[derive(Debug)]
pub struct RollingRate {
    window: Duration,
    events: VecDeque<Instant>,
}

impl RollingRate {
    /// Construct a rolling-rate tracker with the given window width.
    ///
    /// Zero-width windows are rejected (saturated to 1 ns) because
    /// dividing by zero would produce `inf`, and a "rate over zero
    /// time" has no defined meaning.
    #[must_use]
    pub fn new(window: Duration) -> Self {
        let window = if window.is_zero() {
            Duration::from_nanos(1)
        } else {
            window
        };
        Self {
            window,
            events: VecDeque::new(),
        }
    }

    /// Record an event at `now`. Separate from [`Self::observe`] so
    /// tests can inject a deterministic clock.
    pub fn observe_at(&mut self, now: Instant) {
        self.events.push_back(now);
        self.expire(now);
    }

    /// Record an event at the current instant.
    pub fn observe(&mut self) {
        self.observe_at(Instant::now());
    }

    /// Expire entries older than `window` relative to `now`.
    fn expire(&mut self, now: Instant) {
        while let Some(front) = self.events.front().copied() {
            if now.duration_since(front) > self.window {
                self.events.pop_front();
            } else {
                break;
            }
        }
    }

    /// Per-second rate at the given instant. Ages out stale entries
    /// first so a long-quiet period shows a rate of zero (instead of
    /// a stale count divided by the window).
    pub fn rate_per_second_at(&mut self, now: Instant) -> f64 {
        self.expire(now);
        let window_s = self.window.as_secs_f64();
        // `expire` guarantees the window is non-zero via `Self::new`.
        self.events.len() as f64 / window_s
    }

    /// Per-second rate at the current instant.
    pub fn rate_per_second(&mut self) -> f64 {
        self.rate_per_second_at(Instant::now())
    }

    /// Current event count in the window. Useful for unit tests.
    #[must_use]
    pub fn window_len(&self) -> usize {
        self.events.len()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn empty_window_reports_zero_rate() {
        let mut r = RollingRate::new(Duration::from_secs(1));
        assert_eq!(r.rate_per_second_at(Instant::now()), 0.0);
    }

    #[test]
    fn observations_inside_window_are_counted() {
        let mut r = RollingRate::new(Duration::from_secs(10));
        let t0 = Instant::now();
        for i in 0..5 {
            r.observe_at(t0 + Duration::from_millis(i * 100));
        }
        let rate = r.rate_per_second_at(t0 + Duration::from_millis(500));
        // 5 events / 10 s = 0.5/s.
        assert!((rate - 0.5).abs() < 1e-9, "expected 0.5/s, got {rate}");
    }

    #[test]
    fn entries_older_than_window_expire() {
        let mut r = RollingRate::new(Duration::from_secs(1));
        let t0 = Instant::now();
        r.observe_at(t0);
        // Later reading outside the window must drop the stale entry.
        let rate = r.rate_per_second_at(t0 + Duration::from_secs(10));
        assert_eq!(rate, 0.0);
        assert_eq!(r.window_len(), 0);
    }

    #[test]
    fn zero_width_window_is_clamped_to_nonzero() {
        let mut r = RollingRate::new(Duration::ZERO);
        // Must not panic or produce NaN / Inf.
        r.observe_at(Instant::now());
        let rate = r.rate_per_second_at(Instant::now());
        assert!(rate.is_finite());
    }
}
