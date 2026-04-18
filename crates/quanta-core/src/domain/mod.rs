//! Core domain types — pure.

use std::path::PathBuf;

/// Engine startup configuration.
#[derive(Clone, Debug)]
pub struct EngineConfig {
    pub socket_path: Option<PathBuf>,
    pub profile_dir: PathBuf,
}

impl EngineConfig {
    #[must_use]
    pub fn new(profile_dir: PathBuf) -> Self {
        Self {
            socket_path: None,
            profile_dir,
        }
    }

    #[must_use]
    pub fn with_socket(mut self, path: PathBuf) -> Self {
        self.socket_path = Some(path);
        self
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn builder_sets_socket() {
        let cfg = EngineConfig::new(PathBuf::from("/profile")).with_socket(PathBuf::from("/sock"));
        assert_eq!(cfg.socket_path, Some(PathBuf::from("/sock")));
        assert_eq!(cfg.profile_dir, PathBuf::from("/profile"));
    }

    #[test]
    fn default_new_has_no_socket() {
        let cfg = EngineConfig::new(PathBuf::from("/p"));
        assert!(cfg.socket_path.is_none());
    }

    #[test]
    fn with_socket_overwrites() {
        let cfg = EngineConfig::new(PathBuf::from("/p"))
            .with_socket(PathBuf::from("/s1"))
            .with_socket(PathBuf::from("/s2"));
        assert_eq!(cfg.socket_path, Some(PathBuf::from("/s2")));
    }

    #[test]
    fn clone_is_independent() {
        let a = EngineConfig::new(PathBuf::from("/a"));
        let b = a.clone();
        assert_eq!(a.profile_dir, b.profile_dir);
        assert!(a.socket_path.is_none() && b.socket_path.is_none());
    }
}
