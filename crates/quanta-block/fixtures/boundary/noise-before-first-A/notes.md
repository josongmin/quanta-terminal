Plain bytes (shell banners, motd, login noise) emit zero boundary events; the
subsequent OSC 133 A is recognised correctly. Guards against a bug where the
VTE parser leaks `execute` / `print` bytes into the sink.
