//! Demonstrate the crash-recovery marker protocol.
//!
//! Run with:
//!
//! ```shell
//! cargo run --example crash_recovery_probe -p quanta-lifecycle
//! ```

use quanta_lifecycle::{FileMarker, MarkerStore, RecoveryOutcome};

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let tmp = tempfile::tempdir()?;
    let m = FileMarker::new(tmp.path());

    // First boot: no marker yet → RecoveredFromCrash is the conservative default.
    let outcome = m.probe_startup()?;
    println!("first probe: {outcome:?}");
    assert_eq!(outcome, RecoveryOutcome::RecoveredFromCrash);

    // Simulate a clean shutdown by writing the marker, then reboot.
    m.write()?;
    let outcome = m.probe_startup()?;
    println!("second probe (after clean shutdown): {outcome:?}");
    assert_eq!(outcome, RecoveryOutcome::CleanStart);

    Ok(())
}
