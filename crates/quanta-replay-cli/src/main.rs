//! `quanta-replay` binary — see `lib.rs` for the library surface.
//!
//! Exit codes:
//!   0 = success
//!   1 = bad usage (argv / flags)
//!   2 = replay failure (event log open, decode, etc.)

use std::io::{self, BufWriter, Write};
use std::process::ExitCode;

use quanta_replay_cli::{argv_requests_help, run_sync, Options, ReplayCliError, HELP_TEXT};

fn main() -> ExitCode {
    let argv: Vec<String> = std::env::args().collect();
    if argv.len() <= 1 || argv_requests_help(&argv) {
        println!("{HELP_TEXT}");
        return ExitCode::from(0);
    }
    let opts = match Options::parse_argv(&argv) {
        Ok(o) => o,
        Err(err) => {
            eprintln!("quanta-replay: {err}");
            eprintln!();
            eprintln!("{HELP_TEXT}");
            return ExitCode::from(1);
        }
    };
    let stdout = io::stdout();
    let mut out = BufWriter::new(stdout.lock());
    match run_sync(&opts, &mut out) {
        Ok(()) => {
            let _ = out.flush();
            ExitCode::from(0)
        }
        Err(err) => match err {
            ReplayCliError::MissingProfileDir
            | ReplayCliError::UnknownFlag(_)
            | ReplayCliError::MissingValue(_)
            | ReplayCliError::BadFormat(_)
            | ReplayCliError::BadSessionId(_)
            | ReplayCliError::BadSeq(_) => {
                eprintln!("quanta-replay: {err}");
                ExitCode::from(1)
            }
            _ => {
                eprintln!("quanta-replay: {err}");
                ExitCode::from(2)
            }
        },
    }
}
