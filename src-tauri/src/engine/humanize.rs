//! Random delays (port of `humanize.ts`). The uniform source is injected so tests are deterministic.

use crate::model::FishingConfig;

/// A uniform [0, 1) source.
pub type Rand<'a> = &'a mut dyn FnMut() -> f64;

/// Standard normal draw (Box-Muller).
fn gaussian(rand: Rand) -> f64 {
    let u1 = 1.0 - rand(); // (0, 1]: avoids ln(0)
    let u2 = rand();
    (-2.0 * u1.ln()).sqrt() * (2.0 * std::f64::consts::PI * u2).cos()
}

/// Delay before the next /fish, in ms: truncated normal centered on `base`, std-dev `jitter / 2`,
/// clamped to [max(2, base - jitter), base + jitter] seconds.
pub fn fish_delay_ms(cfg: &FishingConfig, rand: Rand) -> i64 {
    let (base, jitter) = (cfg.base_cooldown_sec, cfg.jitter_sec);
    let lo = (base - jitter).max(2.0);
    let hi = (base + jitter).max(lo);
    let v = base + gaussian(rand) * (jitter / 2.0);
    (v.clamp(lo, hi) * 1000.0).round() as i64
}

/// Uniform delay in ms between `min_s` and `max_s` seconds.
pub fn random_between_ms(min_s: f64, max_s: f64, rand: Rand) -> i64 {
    ((min_s + rand() * (max_s - min_s)) * 1000.0).round() as i64
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cfg(base: f64, jitter: f64) -> FishingConfig {
        FishingConfig { base_cooldown_sec: base, jitter_sec: jitter, min_gap_sec: 2.5 }
    }

    #[test]
    fn stays_within_bounds_over_1000_draws() {
        let mut seed = 12345u64;
        let mut rand = move || {
            seed = seed.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407);
            (seed >> 11) as f64 / (1u64 << 53) as f64
        };
        for _ in 0..1000 {
            let d = fish_delay_ms(&cfg(3.5, 0.8), &mut rand);
            assert!((2700..=4300).contains(&d), "{d}");
        }
    }

    #[test]
    fn never_under_2000_ms() {
        let mut low = || 0.999_999_999;
        assert!(fish_delay_ms(&cfg(2.0, 1.0), &mut low) >= 2000);
    }

    #[test]
    fn clamped_with_extreme_values_and_centered() {
        let mut seq = [0.999_999_999, 0.5].into_iter().cycle();
        let mut extreme = move || seq.next().unwrap();
        assert_eq!(fish_delay_ms(&cfg(3.5, 0.8), &mut extreme), 2700);
        let mut half = || 0.5;
        assert_eq!(fish_delay_ms(&cfg(3.5, 0.8), &mut half), 3029);
    }

    #[test]
    fn random_between_maps_the_range() {
        let mut zero = || 0.0;
        let mut half = || 0.5;
        assert_eq!(random_between_ms(5.0, 15.0, &mut zero), 5000);
        assert_eq!(random_between_ms(5.0, 15.0, &mut half), 10_000);
    }
}
