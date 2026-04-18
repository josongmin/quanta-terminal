//! Boundary detector port.
//!
//! Adapters implement this trait. The domain consumes it through a trait object
//! or a generic parameter; the domain itself never knows about `vte` or any
//! other concrete parser.

use crate::domain::BoundarySink;

/// Stream-oriented detector that consumes PTY bytes and emits [`BoundaryEvent`]s
/// through a sink.
///
/// Implementations are stateful across calls: partial escape sequences split
/// across `feed` calls must be remembered until completion.
pub trait BoundaryDetector {
    /// Feed raw bytes from the PTY. Emits zero or more events into `sink`.
    fn feed(&mut self, bytes: &[u8], sink: &mut dyn BoundarySink);
}

// Blanket impl so adapters can expose their concrete type and callers can
// still speak in terms of the port without boxing.
impl<T: BoundaryDetector + ?Sized> BoundaryDetector for &mut T {
    fn feed(&mut self, bytes: &[u8], sink: &mut dyn BoundarySink) {
        (**self).feed(bytes, sink);
    }
}
