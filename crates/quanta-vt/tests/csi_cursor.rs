//! CSI cursor movement tests.

mod common;

use common::grid;

#[test]
fn cup_moves_cursor_absolute() {
    let mut g = grid(10, 20);
    let _ = g.feed(b"\x1b[5;7H");
    let c = g.cursor();
    assert_eq!(c.row, 4);
    assert_eq!(c.col, 6);
}

#[test]
fn cup_defaults_to_1_1() {
    let mut g = grid(10, 20);
    let _ = g.feed(b"\x1b[3;3H\x1b[H");
    let c = g.cursor();
    assert_eq!(c.row, 0);
    assert_eq!(c.col, 0);
}

#[test]
fn cuu_moves_up() {
    let mut g = grid(10, 20);
    let _ = g.feed(b"\x1b[5;5H\x1b[2A");
    let c = g.cursor();
    assert_eq!(c.row, 2);
    assert_eq!(c.col, 4);
}

#[test]
fn cud_moves_down() {
    let mut g = grid(10, 20);
    let _ = g.feed(b"\x1b[3B");
    let c = g.cursor();
    assert_eq!(c.row, 3);
}

#[test]
fn cuf_moves_right() {
    let mut g = grid(10, 20);
    let _ = g.feed(b"\x1b[5C");
    assert_eq!(g.cursor().col, 5);
}

#[test]
fn cub_moves_left() {
    let mut g = grid(10, 20);
    let _ = g.feed(b"\x1b[10;10H\x1b[3D");
    assert_eq!(g.cursor().col, 6);
}

#[test]
fn cursor_clamps_to_last_row() {
    let mut g = grid(5, 10);
    let _ = g.feed(b"\x1b[100B");
    assert_eq!(g.cursor().row, 4);
}

#[test]
fn cursor_clamps_to_last_col() {
    let mut g = grid(5, 10);
    let _ = g.feed(b"\x1b[100C");
    assert_eq!(g.cursor().col, 9);
}

#[test]
fn cursor_clamps_to_first_row() {
    let mut g = grid(5, 10);
    let _ = g.feed(b"\x1b[100A");
    assert_eq!(g.cursor().row, 0);
}

#[test]
fn cursor_clamps_to_first_col() {
    let mut g = grid(5, 10);
    let _ = g.feed(b"\x1b[100D");
    assert_eq!(g.cursor().col, 0);
}

#[test]
fn cha_horizontal_absolute() {
    let mut g = grid(5, 20);
    let _ = g.feed(b"\x1b[5G");
    assert_eq!(g.cursor().col, 4);
}

#[test]
fn vpa_vertical_absolute() {
    let mut g = grid(10, 20);
    let _ = g.feed(b"\x1b[7d");
    assert_eq!(g.cursor().row, 6);
}

#[test]
fn cnl_next_line() {
    let mut g = grid(10, 20);
    let _ = g.feed(b"\x1b[5;10H\x1b[2E");
    let c = g.cursor();
    assert_eq!(c.row, 6);
    assert_eq!(c.col, 0);
}

#[test]
fn cpl_prev_line() {
    let mut g = grid(10, 20);
    let _ = g.feed(b"\x1b[5;10H\x1b[2F");
    let c = g.cursor();
    assert_eq!(c.row, 2);
    assert_eq!(c.col, 0);
}

#[test]
fn cup_cursor_mid_row_stays_after_text() {
    let mut g = grid(5, 20);
    let _ = g.feed(b"\x1b[2;3Hx");
    assert_eq!(g.cursor().row, 1);
    assert_eq!(g.cursor().col, 3);
}

#[test]
fn multiple_commands_compose() {
    let mut g = grid(10, 20);
    let _ = g.feed(b"\x1b[2;5H\x1b[3B\x1b[2C");
    let c = g.cursor();
    assert_eq!(c.row, 4);
    assert_eq!(c.col, 6);
}
