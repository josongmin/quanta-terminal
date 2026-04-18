//! `check-adr-compliance` — one-line-per-ADR mechanical audit.
//!
//! The goal is NOT to semantically reason about ADRs. The goal is to catch
//! mechanical violations early: "the ADR says file X must exist — does it?"
//! or "the ADR names type T — does the symbol still live where the ADR says?"
//!
//! Every check prints exactly one line of the form:
//!
//!   ADR-NNNN <pass|fail|skip|info>: <short message>
//!
//! Exit code:
//!   0 — no ADR reported `fail`.
//!   1 — at least one `fail`.
//!
//! `skip` is for intentional non-goals in Phase 1 (e.g. history search,
//! parser rollout). They do NOT fail the run but are surfaced so the report
//! is a complete audit of every ADR.
//!
//! Extending: each ADR lives in its own `check_adr_NNNN` fn for grep-ability.
//! Keep the checks cheap — this runs on every CI and on every pre-commit.

use std::fs;
use std::path::{Path, PathBuf};
use std::process::ExitCode;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Status {
    Pass,
    Fail,
    /// Intentional Phase-1 non-goal. Reported so the per-ADR row exists, but
    /// does NOT fail the run. See ADR notes on each check.
    Skip,
}

impl Status {
    fn label(self) -> &'static str {
        match self {
            Status::Pass => "pass",
            Status::Fail => "fail",
            Status::Skip => "skip",
        }
    }
}

struct Report {
    rows: Vec<(u16, Status, String)>,
}

impl Report {
    fn new() -> Self {
        Self { rows: Vec::new() }
    }

    fn push(&mut self, adr: u16, status: Status, message: impl Into<String>) {
        self.rows.push((adr, status, message.into()));
    }

    fn print(&self) {
        let mut rows = self.rows.clone();
        rows.sort_by_key(|(adr, ..)| *adr);
        for (adr, status, msg) in &rows {
            println!("ADR-{adr:04} {:<4}: {msg}", status.label());
        }
    }

    fn any_failed(&self) -> bool {
        self.rows.iter().any(|(_, s, _)| *s == Status::Fail)
    }
}

/// Locate the workspace root. In the workspace `cargo run -p check-adr-compliance`
/// sets CWD to the workspace root; we nonetheless resolve defensively via the
/// manifest dir + two parents so the binary also works when invoked standalone.
fn workspace_root() -> PathBuf {
    let manifest = env!("CARGO_MANIFEST_DIR");
    Path::new(manifest)
        .parent()
        .and_then(Path::parent)
        .map(Path::to_path_buf)
        .unwrap_or_else(|| PathBuf::from("."))
}

/// Small convenience: does any file under `root` (recursing into subdirs)
/// contain the given substring? Binary files and hidden dirs are skipped.
/// Used for spot checks ("does some file export this symbol") that don't
/// warrant pulling `syn` for a full parse.
fn any_file_contains(root: &Path, needle: &str) -> bool {
    let mut stack = vec![root.to_path_buf()];
    while let Some(dir) = stack.pop() {
        let Ok(entries) = fs::read_dir(&dir) else {
            continue;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            let Ok(ft) = entry.file_type() else { continue };
            let name = entry.file_name();
            let name = name.to_string_lossy();
            if name.starts_with('.') {
                continue;
            }
            if ft.is_dir() {
                if name == "target" || name == "node_modules" || name == "dist" {
                    continue;
                }
                stack.push(path);
            } else if ft.is_file() {
                // Restrict to source-adjacent files. Binaries and lockfiles
                // can contain spurious matches.
                let ext = path
                    .extension()
                    .and_then(|e| e.to_str())
                    .unwrap_or_default();
                if !matches!(
                    ext,
                    "rs" | "ts" | "tsx" | "mjs" | "js" | "md" | "toml" | "json"
                ) {
                    continue;
                }
                if let Ok(s) = fs::read_to_string(&path) {
                    if s.contains(needle) {
                        return true;
                    }
                }
            }
        }
    }
    false
}

fn grep_in_file(path: &Path, needle: &str) -> bool {
    fs::read_to_string(path)
        .map(|s| s.contains(needle))
        .unwrap_or(false)
}

// --- ADR checks ---

fn check_adr_0001(root: &Path, r: &mut Report) {
    // Host modes: packages/host-common and packages/host-tauri exist, and
    // the UI package never imports from host-tauri (enforced by
    // check-fsd-layers.mjs, but we smoke-grep here so the report is
    // self-contained).
    let common_exists = root.join("packages/host-common").is_dir();
    let tauri_exists = root.join("packages/host-tauri").is_dir();
    if !common_exists || !tauri_exists {
        r.push(
            1,
            Status::Fail,
            format!(
                "host packages missing (host-common={}, host-tauri={})",
                common_exists, tauri_exists
            ),
        );
        return;
    }
    let ui_src = root.join("packages/ui/src");
    if any_file_contains(&ui_src, "@quanta/host-tauri") {
        r.push(
            1,
            Status::Fail,
            "packages/ui imports @quanta/host-tauri (ADR 0001 forbids host-specific imports in UI)",
        );
        return;
    }
    r.push(
        1,
        Status::Pass,
        "host-common + host-tauri present; ui does not import host-tauri",
    );
}

fn check_adr_0002(root: &Path, r: &mut Report) {
    // Execution Boundary: quanta-block has a boundary module and a boundary_corpus
    // test. Boundary signals are defined in quanta-proto::events::BoundarySignal.
    let boundary_src = root.join("crates/quanta-block/src/domain/boundary.rs");
    let corpus = root.join("crates/quanta-block/tests/boundary_corpus.rs");
    let boundary_signals = root.join("crates/quanta-proto/src/events.rs");
    let has_signals = grep_in_file(&boundary_signals, "pub enum BoundarySignal");
    if boundary_src.exists() && corpus.exists() && has_signals {
        r.push(
            2,
            Status::Pass,
            "boundary domain + corpus test + BoundarySignal proto enum present",
        );
    } else {
        r.push(
            2,
            Status::Fail,
            format!(
                "expected boundary.rs ({}) + boundary_corpus.rs ({}) + BoundarySignal enum ({})",
                boundary_src.exists(),
                corpus.exists(),
                has_signals
            ),
        );
    }
}

fn check_adr_0003(root: &Path, r: &mut Report) {
    // Session metadata: SessionCreated has `launch_cwd`.
    let events_rs = root.join("crates/quanta-proto/src/events.rs");
    let text = fs::read_to_string(&events_rs).unwrap_or_default();
    if text.contains("pub struct SessionCreated") && text.contains("pub launch_cwd") {
        r.push(
            3,
            Status::Pass,
            "SessionCreated.launch_cwd present (authoritative tier)",
        );
    } else {
        r.push(
            3,
            Status::Fail,
            "SessionCreated.launch_cwd missing from quanta-proto/src/events.rs",
        );
    }
}

fn check_adr_0004(root: &Path, r: &mut Report) {
    // Sidecar lifecycle: handshake types + handshake test exist.
    let protocol_rs = root.join("crates/quanta-proto/src/protocol.rs");
    let protocol_text = fs::read_to_string(&protocol_rs).unwrap_or_default();
    let hs_test = root.join("crates/quanta-protocol/tests/handshake.rs");
    let has_hello = protocol_text.contains("pub struct Hello");
    let has_ready = protocol_text.contains("pub struct Ready");
    let has_incompat = protocol_text.contains("pub struct Incompatible");
    if has_hello && has_ready && has_incompat && hs_test.exists() {
        r.push(
            4,
            Status::Pass,
            "Hello/Ready/Incompatible defined; handshake.rs test present",
        );
    } else {
        r.push(
            4,
            Status::Fail,
            format!(
                "handshake surface incomplete (Hello={has_hello}, Ready={has_ready}, Incompatible={has_incompat}, test_file={})",
                hs_test.exists()
            ),
        );
    }
}

fn check_adr_0005(root: &Path, r: &mut Report) {
    // Storage and Retention: event log uses zstd segments.
    let events_crate = root.join("crates/quanta-events/src/adapters/zstd_segment.rs");
    let events_cargo = root.join("crates/quanta-events/Cargo.toml");
    let zstd_dep = fs::read_to_string(&events_cargo)
        .map(|t| t.contains("zstd"))
        .unwrap_or(false);
    if events_crate.exists() && zstd_dep {
        r.push(5, Status::Pass, "zstd-segmented event log adapter present");
    } else {
        r.push(
            5,
            Status::Fail,
            format!(
                "missing zstd event log (adapter={}, zstd_dep={})",
                events_crate.exists(),
                zstd_dep
            ),
        );
    }
}

fn check_adr_0006(root: &Path, r: &mut Report) {
    // Phase-1 redaction infrastructure:
    //   1. `quanta-security` crate exists with the hex layout.
    //   2. The `SecretDetector` port + `DefaultDetector` adapter are
    //      defined under the conventional paths.
    //   3. The session actor wires redaction into `submit_input` — grep for
    //      `SecretDetector` usage in `actor.rs`.
    //   4. The session integration test `redaction.rs` is present.
    //   5. Fixtures exist (env + commands + tokens) so the rule catalog has
    //      a corpus gate.
    let sec_root = root.join("crates/quanta-security");
    let sec_cargo = sec_root.join("Cargo.toml");
    let ports = sec_root.join("src/ports/mod.rs");
    let adapters = sec_root.join("src/adapters/default");
    let actor = root.join("crates/quanta-session/src/adapters/actor.rs");
    let integration_test = root.join("crates/quanta-session/tests/redaction.rs");
    let fixtures_env = sec_root.join("fixtures/env");
    let fixtures_cmd = sec_root.join("fixtures/commands");
    let fixtures_tok = sec_root.join("fixtures/tokens");

    let mut missing: Vec<&'static str> = Vec::new();
    if !sec_cargo.exists() {
        missing.push("crates/quanta-security/Cargo.toml");
    }
    if !ports.exists() {
        missing.push("crates/quanta-security/src/ports/mod.rs");
    }
    if !adapters.is_dir() {
        missing.push("crates/quanta-security/src/adapters/default/");
    }
    if !integration_test.exists() {
        missing.push("crates/quanta-session/tests/redaction.rs");
    }
    if !fixtures_env.is_dir() || !fixtures_cmd.is_dir() || !fixtures_tok.is_dir() {
        missing.push("crates/quanta-security/fixtures/{env,commands,tokens}");
    }

    let actor_uses_detector = grep_in_file(&actor, "SecretDetector");

    if missing.is_empty() && actor_uses_detector {
        r.push(
            6,
            Status::Pass,
            "quanta-security wired into session actor; redaction integration test + fixture corpus present",
        );
    } else {
        use std::fmt::Write as _;
        let mut msg = String::new();
        if !missing.is_empty() {
            let _ = write!(msg, "missing paths: {missing:?}");
        }
        if !actor_uses_detector {
            if !msg.is_empty() {
                msg.push_str("; ");
            }
            msg.push_str("session actor does not reference SecretDetector");
        }
        r.push(6, Status::Fail, msg);
    }
}

fn check_adr_0007(root: &Path, r: &mut Report) {
    // Parser rollout: quanta-diagnostic crate must at least have Cargo.toml
    // as the stub lands. Fixtures alone don't make a crate.
    let diag_cargo = root.join("crates/quanta-diagnostic/Cargo.toml");
    let diag_lib = root.join("crates/quanta-diagnostic/src/lib.rs");
    if diag_cargo.exists() && diag_lib.exists() {
        r.push(7, Status::Pass, "quanta-diagnostic stub crate present");
    } else {
        r.push(
            7,
            Status::Fail,
            format!(
                "quanta-diagnostic stub missing (Cargo.toml={}, src/lib.rs={})",
                diag_cargo.exists(),
                diag_lib.exists()
            ),
        );
    }
}

fn check_adr_0008(root: &Path, r: &mut Report) {
    // Raw/TUI mode: BlockTuiEntered / BlockTuiExited proto events exist.
    let events_rs = root.join("crates/quanta-proto/src/events.rs");
    let text = fs::read_to_string(&events_rs).unwrap_or_default();
    if text.contains("BlockTuiEntered") && text.contains("BlockTuiExited") {
        r.push(
            8,
            Status::Pass,
            "BlockTuiEntered/BlockTuiExited events defined",
        );
    } else {
        r.push(
            8,
            Status::Fail,
            "BlockTuiEntered/BlockTuiExited missing in proto",
        );
    }
}

fn check_adr_0009(root: &Path, r: &mut Report) {
    // Input routing: InputKind carries at least `Shell` and `Intent` variants.
    // The classifier is an explicit Phase-1 non-goal.
    let events_rs = root.join("crates/quanta-proto/src/events.rs");
    let text = fs::read_to_string(&events_rs).unwrap_or_default();
    let has_shell = text.contains("pub enum InputKind") && text.contains("Shell");
    let has_intent = text.contains("Intent,");
    if has_shell && has_intent {
        r.push(
            9,
            Status::Pass,
            "InputKind has Shell + Intent variants (classifier is Phase-1 non-goal)",
        );
    } else {
        r.push(9, Status::Fail, "InputKind missing Shell or Intent variant");
    }
}

fn check_adr_0010(root: &Path, r: &mut Report) {
    // Degraded Mode UI: primitives under packages/ui/src/shared/ui/ include
    // badge, banner, tooltip. FSD tool enforces directory layout; here we
    // just assert the directory presence.
    let shared = root.join("packages/ui/src/shared/ui");
    let mut missing: Vec<&'static str> = Vec::new();
    for p in ["badge", "banner", "tooltip"] {
        if !shared.join(p).is_dir() {
            missing.push(p);
        }
    }
    if missing.is_empty() {
        r.push(
            10,
            Status::Pass,
            "badge/banner/tooltip primitives present under packages/ui/src/shared/ui",
        );
    } else {
        r.push(10, Status::Fail, format!("missing primitives: {missing:?}"));
    }
}

fn check_adr_0011(root: &Path, r: &mut Report) {
    // Event replay: replay_determinism test exists in quanta-events.
    let test = root.join("crates/quanta-events/tests/replay_determinism.rs");
    if test.exists() {
        r.push(
            11,
            Status::Pass,
            "replay_determinism test present in quanta-events",
        );
    } else {
        r.push(
            11,
            Status::Fail,
            "replay_determinism.rs missing from crates/quanta-events/tests/",
        );
    }
}

fn check_adr_0012(root: &Path, r: &mut Report) {
    // Risk classification: RiskLevel derives PartialOrd, Ord.
    let events_rs = root.join("crates/quanta-proto/src/events.rs");
    let text = fs::read_to_string(&events_rs).unwrap_or_default();
    // Find the RiskLevel block and its immediately preceding derive attrs.
    // The ADR requires monotonic ordering via derive, not a manual impl.
    let idx = text.find("pub enum RiskLevel");
    let Some(idx) = idx else {
        r.push(12, Status::Fail, "RiskLevel enum missing");
        return;
    };
    let prelude = &text[idx.saturating_sub(400)..idx];
    if prelude.contains("PartialOrd") && prelude.contains("Ord") {
        r.push(
            12,
            Status::Pass,
            "RiskLevel derives PartialOrd + Ord (monotonic risk order)",
        );
    } else {
        r.push(12, Status::Fail, "RiskLevel missing PartialOrd/Ord derives");
    }
}

fn check_adr_0013(_root: &Path, r: &mut Report) {
    r.push(13, Status::Skip, "history search — Phase-1 non-goal");
}

fn check_adr_0014(root: &Path, r: &mut Report) {
    // Repository structure: the two layer-check tools exist and are wired.
    let hex = root.join("tools/check-hex-imports/src/main.rs");
    let fsd = root.join("tools/check-fsd-layers.mjs");
    if hex.exists() && fsd.exists() {
        r.push(
            14,
            Status::Pass,
            "check-hex-imports + check-fsd-layers.mjs present (CI-enforced)",
        );
    } else {
        r.push(
            14,
            Status::Fail,
            format!(
                "layer-check tools missing (hex={}, fsd={})",
                hex.exists(),
                fsd.exists()
            ),
        );
    }
}

fn main() -> ExitCode {
    let root = workspace_root();
    let mut r = Report::new();

    check_adr_0001(&root, &mut r);
    check_adr_0002(&root, &mut r);
    check_adr_0003(&root, &mut r);
    check_adr_0004(&root, &mut r);
    check_adr_0005(&root, &mut r);
    check_adr_0006(&root, &mut r);
    check_adr_0007(&root, &mut r);
    check_adr_0008(&root, &mut r);
    check_adr_0009(&root, &mut r);
    check_adr_0010(&root, &mut r);
    check_adr_0011(&root, &mut r);
    check_adr_0012(&root, &mut r);
    check_adr_0013(&root, &mut r);
    check_adr_0014(&root, &mut r);

    r.print();
    if r.any_failed() {
        ExitCode::from(1)
    } else {
        ExitCode::SUCCESS
    }
}
