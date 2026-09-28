use serde::Serialize;
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

#[derive(Default)]
struct Timer { elapsed: Duration, running_since: Option<Instant> }
impl Timer {
    fn elapsed(&self, now: Instant) -> Duration {
        self.elapsed + self.running_since.map(|start| now.saturating_duration_since(start)).unwrap_or_default()
    }
    fn set_paused(&mut self, paused: bool, now: Instant) {
        if paused { self.elapsed = self.elapsed(now); self.running_since = None; }
        else if self.running_since.is_none() { self.running_since = Some(now); }
    }
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot { pub paused: bool, pub elapsed_seconds: f64 }
static TIMER: OnceLock<Mutex<Timer>> = OnceLock::new();
pub fn snapshot(action: Option<bool>, toggle: bool) -> Snapshot {
    let mut timer = TIMER.get_or_init(|| Mutex::new(Timer::default())).lock().unwrap_or_else(|e| e.into_inner());
    let now = Instant::now();
    if toggle { let paused = timer.running_since.is_some(); timer.set_paused(paused, now); }
    else if let Some(paused) = action { timer.set_paused(paused, now); }
    Snapshot { paused: timer.running_since.is_none(), elapsed_seconds: timer.elapsed(now).as_secs_f64() }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn paused_time_is_excluded_and_repeated_start_does_not_reset() {
        let start = Instant::now(); let mut timer = Timer::default();
        timer.set_paused(false, start);
        timer.set_paused(false, start + Duration::from_secs(2));
        timer.set_paused(true, start + Duration::from_secs(5));
        assert_eq!(timer.elapsed(start + Duration::from_secs(20)), Duration::from_secs(5));
        timer.set_paused(false, start + Duration::from_secs(20));
        assert_eq!(timer.elapsed(start + Duration::from_secs(23)), Duration::from_secs(8));
    }
}
