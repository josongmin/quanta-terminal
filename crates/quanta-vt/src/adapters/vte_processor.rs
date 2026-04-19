//! `vte` parser adapter. Implements [`vte::Perform`] against a mutable
//! [`crate::Grid`].
//!
//! This is the ONLY file in the crate that imports `vte::`. Domain / ports
//! speak in grid mutations and [`crate::TerminalEvent`] values; raw bytes
//! never leave this module.

use vte::{Params, Parser, Perform};

use crate::domain::charset::{CharsetSlot, CharsetTable};
use crate::domain::cursor::CursorShape;
use crate::domain::grid::Grid;
use crate::ports::event::{ClipboardPayload, SyncUpdatePayload, TerminalEvent};

/// Byte-level pre-filter state.
///
/// The upstream `vte` state machine does not accept BEL (0x07) as an ST
/// surrogate inside DCS — unlike OSC, where BEL-termination is standard
/// xterm practice. Some in-the-wild apps incorrectly terminate DCS with
/// BEL, leaving the parser stuck in DCS state and silently swallowing
/// follow-up output.
///
/// We work around the vte limitation by tracking DCS entry/exit on the
/// raw byte stream *before* vte sees the bytes. When we observe a BEL
/// while we believe we're inside a DCS envelope, we rewrite the BEL to
/// the canonical ST sequence (`ESC \`) that vte does understand. vte's
/// own FSM remains untouched.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum PrefilterState {
    /// Ground — no in-flight DCS from our perspective.
    Ground,
    /// We just saw an `ESC` in Ground; the next byte decides if this is
    /// a DCS opener (`P`) or something else.
    EscPending,
    /// Inside a DCS envelope (we saw `ESC P`). BEL is a termination
    /// candidate here.
    DcsActive,
    /// Inside DCS and we just saw `ESC` — it might be the start of an
    /// ST (`ESC \`), or a nested ESC that aborts the DCS. Either way,
    /// vte handles the transition; we just need to leave DCS state.
    DcsEscPending,
}

/// Processor — holds the `vte::Parser` and a mutable grid borrow for the
/// duration of a `feed()` call. Designed to be re-constructed per call so
/// borrow lifetimes stay tight.
pub struct VteProcessor<'g> {
    grid: &'g mut Grid,
    parser: Parser,
    dcs: Option<DcsAccumulator>,
    prefilter: PrefilterState,
}

impl std::fmt::Debug for VteProcessor<'_> {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("VteProcessor").finish()
    }
}

impl<'g> VteProcessor<'g> {
    /// Construct.
    pub fn new(grid: &'g mut Grid) -> Self {
        Self {
            grid,
            parser: Parser::new(),
            dcs: None,
            prefilter: PrefilterState::Ground,
        }
    }

    /// Feed bytes. All cell / mode mutations happen on the borrowed grid.
    ///
    /// A single-pass byte pre-filter rewrites `BEL` (0x07) inside a DCS
    /// envelope to `ESC \` (ST) so the upstream vte FSM can close the
    /// DCS cleanly. Everything else passes through untouched.
    pub fn feed(&mut self, bytes: &[u8]) {
        let Self {
            grid,
            parser,
            dcs,
            prefilter,
        } = self;
        let mut performer = Performer { grid, dcs };
        for &b in bytes {
            match (*prefilter, b) {
                // ── Ground ──
                (PrefilterState::Ground, 0x1b) => {
                    *prefilter = PrefilterState::EscPending;
                    parser.advance(&mut performer, b);
                }
                (PrefilterState::Ground, _) => {
                    parser.advance(&mut performer, b);
                }
                // ── Just saw ESC in Ground ──
                (PrefilterState::EscPending, b'P') => {
                    // ESC P → DCS opens.
                    *prefilter = PrefilterState::DcsActive;
                    parser.advance(&mut performer, b);
                }
                (PrefilterState::EscPending, 0x1b) => {
                    // Another ESC — stay in EscPending; vte handles it.
                    parser.advance(&mut performer, b);
                }
                (PrefilterState::EscPending, _) => {
                    // ESC <anything-but-P> — not a DCS. Back to Ground.
                    *prefilter = PrefilterState::Ground;
                    parser.advance(&mut performer, b);
                }
                // ── Inside DCS envelope ──
                (PrefilterState::DcsActive, 0x07) => {
                    // Non-standard BEL terminator. Rewrite to ESC\ so vte
                    // closes the DCS cleanly. Emit both bytes to the
                    // parser in order; update our prefilter state back
                    // to Ground (matching vte's post-ST Ground).
                    parser.advance(&mut performer, 0x1b);
                    parser.advance(&mut performer, b'\\');
                    *prefilter = PrefilterState::Ground;
                }
                (PrefilterState::DcsActive, 0x1b) => {
                    // ESC inside DCS — either the start of ST or an
                    // abort. Let vte decide; we watch the next byte.
                    *prefilter = PrefilterState::DcsEscPending;
                    parser.advance(&mut performer, b);
                }
                (PrefilterState::DcsActive, 0x18 | 0x1a) => {
                    // CAN (0x18) / SUB (0x1a) — ECMA-48 abort. vte drops
                    // back to Ground on these too.
                    *prefilter = PrefilterState::Ground;
                    parser.advance(&mut performer, b);
                }
                (PrefilterState::DcsActive, _) => {
                    parser.advance(&mut performer, b);
                }
                // ── ESC seen inside DCS ──
                (PrefilterState::DcsEscPending, b'\\') => {
                    // ESC \ — real ST. DCS is closing.
                    *prefilter = PrefilterState::Ground;
                    parser.advance(&mut performer, b);
                }
                (PrefilterState::DcsEscPending, b'P') => {
                    // Nested ESC P — vte treats as a new DCS.
                    *prefilter = PrefilterState::DcsActive;
                    parser.advance(&mut performer, b);
                }
                (PrefilterState::DcsEscPending, 0x1b) => {
                    // ESC ESC — stay pending.
                    parser.advance(&mut performer, b);
                }
                (PrefilterState::DcsEscPending, _) => {
                    // Any other byte — DCS ended (vte does the same).
                    *prefilter = PrefilterState::Ground;
                    parser.advance(&mut performer, b);
                }
            }
        }
    }
}

/// Drive a [`Grid`] with a chunk of PTY bytes and collect the resulting
/// event sequence. Public entry point invoked by
/// [`Grid::feed`](crate::domain::grid::Grid::feed); placed in the adapter
/// layer so `domain/` needs no `use crate::adapters::…` import
/// (hex-layer enforcement, ADR 0014).
pub fn feed_grid(grid: &mut Grid, bytes: &[u8]) -> Vec<crate::ports::event::TerminalEvent> {
    grid.reset_feed_scratch();
    {
        let mut proc = VteProcessor::new(grid);
        proc.feed(bytes);
    }
    grid.finalize_feed()
}

/// Perform implementation held in a local struct so we can split the borrow
/// from the owning `VteProcessor`.
struct Performer<'g, 'p> {
    grid: &'p mut &'g mut Grid,
    dcs: &'p mut Option<DcsAccumulator>,
}

impl Perform for Performer<'_, '_> {
    fn print(&mut self, c: char) {
        self.grid.print_char(c);
    }

    fn execute(&mut self, byte: u8) {
        // Flush pending grapheme before any control op preserves stream order.
        self.grid.flush_grapheme();
        match byte {
            0x07 => self.grid.bell(),
            0x08 => self.grid.backspace(),
            0x09 => self.grid.horizontal_tab(),
            0x0A..=0x0C => self.grid.line_feed(),
            0x0D => self.grid.carriage_return(),
            0x0E => {
                // Shift Out — GL → G1.
                self.grid.charset_mut().gl = CharsetSlot::G1;
            }
            0x0F => {
                self.grid.charset_mut().gl = CharsetSlot::G0;
            }
            _ => {}
        }
    }

    fn hook(&mut self, params: &Params, intermediates: &[u8], _ignore: bool, action: char) {
        self.grid.flush_grapheme();
        *self.dcs = Some(DcsAccumulator::new(params, intermediates, action));
    }

    fn put(&mut self, byte: u8) {
        if let Some(acc) = self.dcs.as_mut() {
            acc.push(byte);
        }
    }

    fn unhook(&mut self) {
        let acc = self.dcs.take();
        let Some(acc) = acc else {
            return;
        };
        match acc.kind() {
            DcsKind::SyncBegin => self
                .grid
                .emit(TerminalEvent::SynchronizedUpdate(SyncUpdatePayload::Begin)),
            DcsKind::SyncEnd => self
                .grid
                .emit(TerminalEvent::SynchronizedUpdate(SyncUpdatePayload::End)),
            DcsKind::Unknown => {
                // Telemetry: count but don't emit.
            }
        }
    }

    fn osc_dispatch(&mut self, params: &[&[u8]], _bell_terminated: bool) {
        self.grid.flush_grapheme();
        if params.is_empty() {
            return;
        }
        let code_bytes = params[0];
        let Some(code) = parse_ascii_u16(code_bytes) else {
            self.grid.bump_unknown_osc();
            return;
        };
        match code {
            0 | 2 => {
                // Title.
                let title = params
                    .get(1)
                    .map(|b| String::from_utf8_lossy(b).into_owned())
                    .unwrap_or_default();
                self.grid.emit(TerminalEvent::TitleChanged(title));
            }
            4 | 10 | 11 | 12 | 104 | 105 | 133 => {
                // OSC passthrough — EPIC-F parses subcodes.
                let mut data = Vec::new();
                for (i, p) in params.iter().enumerate().skip(1) {
                    if i > 1 {
                        data.push(b';');
                    }
                    data.extend_from_slice(p);
                }
                self.grid.emit(TerminalEvent::OscPassthrough { code, data });
            }
            7 => {
                // CWD (URI-encoded).
                let raw = params
                    .get(1)
                    .map(|b| String::from_utf8_lossy(b).into_owned())
                    .unwrap_or_default();
                let decoded = percent_decode(&raw);
                self.grid.emit(TerminalEvent::CwdChanged(decoded));
            }
            8 => {
                // Hyperlink: params = ["8", "<params>", "<uri>"].
                let params_field = params
                    .get(1)
                    .map(|b| String::from_utf8_lossy(b).into_owned())
                    .unwrap_or_default();
                let uri = params
                    .get(2)
                    .map(|b| String::from_utf8_lossy(b).into_owned())
                    .unwrap_or_default();
                if uri.is_empty() {
                    // Close.
                    if let Some(id) = self.grid.open_hyperlink() {
                        self.grid.emit(TerminalEvent::HyperlinkClosed { id });
                        self.grid.set_open_hyperlink(None);
                    }
                } else {
                    let id = self.grid.next_hyperlink_id();
                    let params_opt = if params_field.is_empty() {
                        None
                    } else {
                        Some(params_field)
                    };
                    self.grid.emit(TerminalEvent::HyperlinkOpened {
                        id,
                        uri,
                        params: params_opt,
                    });
                    self.grid.set_open_hyperlink(Some(id));
                }
            }
            52 => {
                // Clipboard. xterm `Pc` may contain multiple selection
                // chars (e.g. `pc` = primary + clipboard). We keep the
                // first char as the primary selection and surface the
                // remainder via `extra_selections` so host adapters can
                // broadcast to every requested target.
                let raw_pc: &[u8] = params.get(1).copied().unwrap_or(&[]);
                let (selection, extra_selections) = if raw_pc.is_empty() {
                    (b'c', Vec::new())
                } else {
                    (raw_pc[0], raw_pc[1..].to_vec())
                };
                let payload = params
                    .get(2)
                    .map(|b| String::from_utf8_lossy(b).into_owned())
                    .unwrap_or_default();
                let clip = if payload == "?" {
                    ClipboardPayload::Query {
                        selection,
                        extra_selections,
                    }
                } else {
                    ClipboardPayload::Set {
                        selection,
                        extra_selections,
                        data: payload,
                    }
                };
                self.grid.emit(TerminalEvent::ClipboardRequest(clip));
            }
            other => {
                self.grid.emit(TerminalEvent::UnknownOsc { code: other });
                self.grid.bump_unknown_osc();
            }
        }
    }

    fn csi_dispatch(&mut self, params: &Params, intermediates: &[u8], ignore: bool, action: char) {
        self.grid.flush_grapheme();
        if ignore {
            self.grid.bump_unknown_csi();
            return;
        }
        let private = intermediates.first().copied() == Some(b'?');
        // Flatten params: a `Params` is an iterator of sub-slices (for
        // sub-params joined by ':'). We flatten to primary values for most
        // commands; extended-SGR uses the full list.
        let primary: Vec<u16> = params
            .iter()
            .map(|sub| sub.first().copied().unwrap_or(0))
            .collect();
        let flat: Vec<u16> = params.iter().flat_map(|sub| sub.iter().copied()).collect();

        let n = |i: usize, default: u16| -> u16 {
            primary
                .get(i)
                .copied()
                .filter(|v| *v != 0)
                .unwrap_or(default)
        };

        match (private, action) {
            (false, 'A') => self.grid.cursor_up(n(0, 1)),
            (false, 'B' | 'e') => self.grid.cursor_down(n(0, 1)),
            (false, 'C' | 'a') => self.grid.cursor_right(n(0, 1)),
            (false, 'D') => self.grid.cursor_left(n(0, 1)),
            (false, 'E') => {
                let rows = n(0, 1);
                self.grid.cursor_down(rows);
                self.grid.carriage_return();
            }
            (false, 'F') => {
                let rows = n(0, 1);
                self.grid.cursor_up(rows);
                self.grid.carriage_return();
            }
            (false, 'G' | '`') => {
                let col = n(0, 1).saturating_sub(1);
                let row = self.grid.cursor().row;
                self.grid.set_cursor_pos(row, col);
            }
            (false, 'd') => {
                let row = n(0, 1).saturating_sub(1);
                let col = self.grid.cursor().col;
                self.grid.set_cursor_pos(row, col);
            }
            (false, 'H' | 'f') => {
                let row = n(0, 1).saturating_sub(1);
                let col = primary
                    .get(1)
                    .copied()
                    .filter(|v| *v != 0)
                    .unwrap_or(1)
                    .saturating_sub(1);
                self.grid.set_cursor_pos(row, col);
            }
            (false, 'J') => {
                let m = primary.first().copied().unwrap_or(0);
                self.grid.erase_in_display(m);
            }
            (false, 'K') => {
                let m = primary.first().copied().unwrap_or(0);
                self.grid.erase_in_line(m);
            }
            (false, 'm') => {
                let out = self.grid.sgr_mut().apply_params(flat.iter().copied());
                if out.unknown > 0 {
                    self.grid.bump_unknown_sgr(out.unknown);
                }
            }
            (false, 'r') => {
                let top = primary.first().copied().filter(|v| *v != 0);
                let bottom = primary.get(1).copied().filter(|v| *v != 0);
                self.grid.set_scroll_region(top, bottom);
            }
            (false, 'S') => {
                self.grid.scroll_up_region(n(0, 1));
            }
            (false, 'T') => {
                self.grid.scroll_down_region(n(0, 1));
            }
            (false, 'q') if intermediates == [b' '] => {
                self.grid
                    .cursor_shape_set(primary.first().copied().unwrap_or(0));
            }
            (true, 'h') => {
                for p in &primary {
                    self.grid.dec_set(*p, true);
                }
            }
            (true, 'l') => {
                for p in &primary {
                    self.grid.dec_set(*p, false);
                }
            }
            _ => {
                self.grid.emit(TerminalEvent::UnknownCsi {
                    final_byte: action as u8,
                    intermediates: intermediates.to_vec(),
                    params: primary,
                });
                self.grid.bump_unknown_csi();
            }
        }
    }

    fn esc_dispatch(&mut self, intermediates: &[u8], _ignore: bool, byte: u8) {
        self.grid.flush_grapheme();
        match (intermediates, byte) {
            (&[b'('], desig) => {
                if let Some(t) = CharsetTable::from_designator(desig) {
                    self.grid.charset_mut().set(CharsetSlot::G0, t);
                }
            }
            (&[b')'], desig) => {
                if let Some(t) = CharsetTable::from_designator(desig) {
                    self.grid.charset_mut().set(CharsetSlot::G1, t);
                }
            }
            (&[b'*'], desig) => {
                if let Some(t) = CharsetTable::from_designator(desig) {
                    self.grid.charset_mut().set(CharsetSlot::G2, t);
                }
            }
            (&[b'+'], desig) => {
                if let Some(t) = CharsetTable::from_designator(desig) {
                    self.grid.charset_mut().set(CharsetSlot::G3, t);
                }
            }
            (&[], b'N') => {
                self.grid.charset_mut().single_shift = Some(CharsetSlot::G2);
            }
            (&[], b'O') => {
                self.grid.charset_mut().single_shift = Some(CharsetSlot::G3);
            }
            (&[], b'7') => self.grid.save_cursor(),
            (&[], b'8') => self.grid.restore_cursor(),
            (&[], b'D') => self.grid.line_feed(),
            (&[], b'M') => self.grid.reverse_index(),
            (&[], b'E') => {
                self.grid.carriage_return();
                self.grid.line_feed();
            }
            (&[], b'c') => self.grid.ris_full_reset(),
            _ => {
                // Unknown escape — silently pass for now; telemetry would
                // bump here.
                let _ = CursorShape::Block; // compile-touch; no-op.
            }
        }
    }
}

/// DCS accumulator — held across hook/put/unhook.
#[derive(Debug)]
pub(crate) struct DcsAccumulator {
    params: Vec<u16>,
    intermediates: Vec<u8>,
    action: char,
    buf: Vec<u8>,
}

impl DcsAccumulator {
    fn new(params: &Params, intermediates: &[u8], action: char) -> Self {
        let params = params
            .iter()
            .map(|sub| sub.first().copied().unwrap_or(0))
            .collect();
        Self {
            params,
            intermediates: intermediates.to_vec(),
            action,
            buf: Vec::new(),
        }
    }

    fn push(&mut self, byte: u8) {
        self.buf.push(byte);
    }

    fn kind(&self) -> DcsKind {
        // Sync update: `DCS = 1 $ q` begin, `DCS = 2 $ q` end.
        // intermediates include `=` / `$`; action is `q` typically.
        if self.action == 'q' && self.intermediates.contains(&b'$') {
            match self.params.first().copied() {
                Some(1) => DcsKind::SyncBegin,
                Some(2) => DcsKind::SyncEnd,
                _ => DcsKind::Unknown,
            }
        } else {
            DcsKind::Unknown
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum DcsKind {
    SyncBegin,
    SyncEnd,
    Unknown,
}

fn parse_ascii_u16(bytes: &[u8]) -> Option<u16> {
    std::str::from_utf8(bytes).ok()?.parse::<u16>().ok()
}

/// Minimal percent-decoder (OSC 7 URI). Hex escapes `%XX` are decoded;
/// everything else passes through. Malformed escapes leave the `%` in place.
fn percent_decode(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let bytes = s.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            let hex = &bytes[i + 1..i + 3];
            if let Ok(hex_str) = std::str::from_utf8(hex) {
                if let Ok(v) = u8::from_str_radix(hex_str, 16) {
                    out.push(v as char);
                    i += 3;
                    continue;
                }
            }
        }
        out.push(bytes[i] as char);
        i += 1;
    }
    // Strip `file://<host>/` prefix if present; leave path.
    if let Some(rest) = out.strip_prefix("file://") {
        if let Some(idx) = rest.find('/') {
            return rest[idx..].to_string();
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn percent_decode_plain_path() {
        assert_eq!(percent_decode("/foo%20bar"), "/foo bar");
    }

    #[test]
    fn percent_decode_strips_file_scheme() {
        assert_eq!(percent_decode("file:///home/user"), "/home/user");
    }

    #[test]
    fn parse_ascii_u16_simple() {
        assert_eq!(parse_ascii_u16(b"133"), Some(133));
        assert_eq!(parse_ascii_u16(b"abc"), None);
    }
}
