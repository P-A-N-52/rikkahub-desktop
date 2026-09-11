use std::{
    ffi::OsString,
    path::{Path, PathBuf},
};

fn extend_path(path: &std::ffi::OsStr, additions: &[PathBuf]) -> Result<OsString, String> {
    let mut paths: Vec<_> = std::env::split_paths(path).collect();
    for addition in additions {
        if !paths.contains(addition) {
            paths.push(addition.clone());
        }
    }
    std::env::join_paths(paths).map_err(|error| format!("Invalid desktop PATH: {error}"))
}

/// Finder keeps system tools on PATH, but commonly omits package-manager bins.
/// Retain explicit precedence and add only existing standard installation dirs.
pub(crate) fn command_path() -> Result<OsString, String> {
    let inherited = std::env::var_os("PATH")
        .filter(|path| !path.is_empty())
        .unwrap_or_else(|| "/usr/bin:/bin:/usr/sbin:/sbin".into());
    let additions: Vec<_> = ["/opt/homebrew/bin", "/usr/local/bin"]
        .into_iter()
        .map(Path::new)
        .filter(|path| path.is_dir())
        .map(Path::to_path_buf)
        .collect();
    extend_path(&inherited, &additions)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn path_preserves_explicit_precedence_and_does_not_duplicate_additions() {
        let result = extend_path(
            std::ffi::OsStr::new("/custom/bin:/usr/bin:/opt/homebrew/bin"),
            &["/opt/homebrew/bin".into(), "/usr/local/bin".into()],
        )
        .unwrap();
        assert_eq!(
            result,
            "/custom/bin:/usr/bin:/opt/homebrew/bin:/usr/local/bin"
        );
    }
}
