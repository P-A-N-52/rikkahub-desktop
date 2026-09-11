//! macOS updates only open a verified, completed download. Installation stays in Finder.

use serde::Deserialize;
use sha2::{Digest, Sha256};
use std::{
    fs::{self, File, Metadata, OpenOptions},
    io::Read,
    os::unix::fs::{MetadataExt, OpenOptionsExt},
    path::{Path, PathBuf},
    process::{Command, Stdio},
};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct DownloadReceipt {
    schema: u32,
    version: String,
    platform: String,
    architecture: String,
    file_name: String,
    size: u64,
    sha256: String,
}

fn asset_architecture(architecture: &str) -> Result<&str, String> {
    match architecture {
        "aarch64" => Ok("arm64"),
        "x86_64" => Ok("x64"),
        _ => Err(format!(
            "Unsupported macOS update architecture: {architecture}"
        )),
    }
}

fn open_regular_file(path: &Path) -> Result<(File, Metadata), String> {
    let file = OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK)
        .open(path)
        .map_err(|error| format!("Cannot read update file {}: {error}", path.display()))?;
    let metadata = file.metadata().map_err(|error| error.to_string())?;
    if !metadata.is_file() || metadata.len() == 0 {
        return Err("Update files must be nonempty regular files".into());
    }
    Ok((file, metadata))
}

fn same_file(before: &Metadata, after: &Metadata) -> bool {
    before.dev() == after.dev()
        && before.ino() == after.ino()
        && before.len() == after.len()
        && before.mtime() == after.mtime()
        && before.mtime_nsec() == after.mtime_nsec()
        && before.ctime() == after.ctime()
        && before.ctime_nsec() == after.ctime_nsec()
}

fn verified_dmg(
    data_dir: &Path,
    requested: &Path,
    version: &str,
    architecture: &str,
) -> Result<PathBuf, String> {
    semver::Version::parse(version).map_err(|_| "Invalid update version".to_string())?;
    let architecture = asset_architecture(architecture)?;
    let name = format!("Rikkahub_{version}_mac_{architecture}.dmg");
    if !requested.is_absolute() || requested.file_name().and_then(|v| v.to_str()) != Some(&name) {
        return Err("Update path does not match this version and Mac architecture".into());
    }

    let data_dir = fs::canonicalize(data_dir).map_err(|error| error.to_string())?;
    let cache = data_dir.join("updates");
    // A configured data directory may itself use an alias, but the update cache cannot
    // redirect elsewhere. Check the directory and final files without following links.
    let cache_metadata = fs::symlink_metadata(&cache).map_err(|error| error.to_string())?;
    if !cache_metadata.is_dir() || cache_metadata.file_type().is_symlink() {
        return Err(
            "Update cache must be a directory inside the application data directory".into(),
        );
    }
    let parent = requested.parent().ok_or("Update path has no parent")?;
    if fs::canonicalize(parent).map_err(|error| error.to_string())? != cache {
        return Err("Update package is outside this application's download cache".into());
    }
    let path = cache.join(&name);
    let (mut file, initial_metadata) = open_regular_file(&path)?;
    let receipt_path = cache.join(format!("{name}.completed.json"));
    let (receipt_file, receipt_metadata) = open_regular_file(&receipt_path)?;
    if receipt_metadata.len() > 32 * 1024 {
        return Err("Update download receipt is too large".into());
    }
    let receipt: DownloadReceipt = serde_json::from_reader(receipt_file.take(32 * 1024 + 1))
        .map_err(|_| "Invalid update download receipt".to_string())?;
    if receipt.schema != 1
        || receipt.platform != "mac"
        || receipt.architecture != architecture
        || receipt.version != version
        || receipt.file_name != name
        || receipt.size != initial_metadata.len()
        || receipt.sha256.len() != 64
        || !receipt
            .sha256
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    {
        return Err("Update download receipt does not match this package".into());
    }
    let mut hasher = Sha256::new();
    let mut buffer = [0_u8; 64 * 1024];
    loop {
        let read = file.read(&mut buffer).map_err(|error| error.to_string())?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
    }
    if format!("{:x}", hasher.finalize()) != receipt.sha256 {
        return Err("Update package checksum does not match its completed download".into());
    }
    let current_metadata = fs::symlink_metadata(&path).map_err(|error| error.to_string())?;
    if !same_file(&initial_metadata, &current_metadata) || current_metadata.file_type().is_symlink()
    {
        return Err("Update package changed during verification; download it again".into());
    }
    Ok(path)
}

pub(crate) fn open_downloaded_dmg(
    data_dir: &Path,
    path: &Path,
    version: &str,
) -> Result<(), String> {
    let path = verified_dmg(data_dir, path, version, std::env::consts::ARCH)?;
    let status = Command::new("/usr/bin/open")
        .arg(path)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .map_err(|error| format!("Failed to open update DMG: {error}"))?;
    if !status.success() {
        return Err(format!("macOS could not open the update DMG ({status})"));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{
        os::unix::fs::symlink,
        sync::atomic::{AtomicU64, Ordering},
    };

    struct Fixture(PathBuf);
    impl Fixture {
        fn new() -> Self {
            static NEXT: AtomicU64 = AtomicU64::new(0);
            let path = std::env::temp_dir().join(format!(
                "rikkahub-update-{}-{}",
                std::process::id(),
                NEXT.fetch_add(1, Ordering::Relaxed)
            ));
            fs::create_dir(&path).unwrap();
            fs::create_dir(path.join("updates")).unwrap();
            Self(path)
        }
        fn package(&self, version: &str, arch: &str) -> PathBuf {
            let name = format!("Rikkahub_{version}_mac_{arch}.dmg");
            let path = self.0.join("updates").join(&name);
            let payload = b"synthetic downloaded package; never opened";
            fs::write(&path, payload).unwrap();
            fs::write(
                path.with_extension("dmg.completed.json"),
                serde_json::to_vec(&serde_json::json!({
                    "schema": 1, "releaseRepo": "owner/repo", "version": version,
                    "platform": "mac", "architecture": arch, "fileName": name,
                    "size": payload.len(), "sha256": format!("{:x}", Sha256::digest(payload)),
                }))
                .unwrap(),
            )
            .unwrap();
            path
        }
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn macos_rejects_the_windows_installer_command() {
        assert!(crate::launch_installer("/tmp/renamed-binary.exe".into())
            .unwrap_err()
            .contains("only be launched on Windows"));
    }

    #[test]
    fn opens_only_matching_architecture_and_exact_semver_in_own_cache() {
        let fixture = Fixture::new();
        for (rust_arch, asset_arch) in [("aarch64", "arm64"), ("x86_64", "x64")] {
            let version = "2.1.0-preview.2+build.01";
            let path = fixture.package(version, asset_arch);
            assert_eq!(
                verified_dmg(&fixture.0, &path, version, rust_arch).unwrap(),
                fs::canonicalize(&path).unwrap()
            );
            assert!(verified_dmg(&fixture.0, &path, "2.1.1", rust_arch).is_err());
        }
        let path = fixture.package("2.1.0", "arm64");
        assert!(verified_dmg(&fixture.0, &path, "2.1.0", "x86_64").is_err());
        assert!(verified_dmg(&fixture.0, &path, "2.1.0", "riscv64").is_err());
        for version in [
            " v2.1.0", "v2.1.0", "2.1.0 ", "2.01.0", "2.1.0-01", "../2.1.0", "2.1.0/",
        ] {
            assert!(verified_dmg(&fixture.0, &path, version, "aarch64").is_err());
        }
    }

    #[test]
    fn rejects_incomplete_corrupted_empty_and_non_dmg_packages() {
        let fixture = Fixture::new();
        let path = fixture.package("2.1.0", "arm64");
        let receipt = path.with_extension("dmg.completed.json");
        fs::remove_file(&receipt).unwrap();
        assert!(verified_dmg(&fixture.0, &path, "2.1.0", "aarch64").is_err());
        fixture.package("2.1.0", "arm64");
        fs::write(&path, b"changed bytes").unwrap();
        assert!(verified_dmg(&fixture.0, &path, "2.1.0", "aarch64").is_err());
        fixture.package("2.1.0", "arm64");
        let mut bytes = fs::read(&path).unwrap();
        bytes[0] ^= 1;
        fs::write(&path, bytes).unwrap();
        assert!(verified_dmg(&fixture.0, &path, "2.1.0", "aarch64")
            .unwrap_err()
            .contains("checksum"));
        fs::write(&path, b"").unwrap();
        assert!(verified_dmg(&fixture.0, &path, "2.1.0", "aarch64").is_err());
        fs::remove_file(&path).unwrap();
        fs::create_dir(&path).unwrap();
        assert!(verified_dmg(&fixture.0, &path, "2.1.0", "aarch64").is_err());
        assert!(verified_dmg(&fixture.0, &path.with_extension("exe"), "2.1.0", "aarch64").is_err());
        assert!(verified_dmg(
            &fixture.0,
            Path::new("Rikkahub_2.1.0_mac_arm64.dmg"),
            "2.1.0",
            "aarch64"
        )
        .is_err());
    }

    #[test]
    fn rejects_external_paths_subdirectories_and_symlink_files_or_cache() {
        let fixture = Fixture::new();
        let other = Fixture::new();
        let outside = other.package("2.1.0", "arm64");
        assert!(verified_dmg(&fixture.0, &outside, "2.1.0", "aarch64").is_err());
        let path = fixture.package("2.1.0", "arm64");
        fs::remove_file(&path).unwrap();
        symlink(&outside, &path).unwrap();
        assert!(verified_dmg(&fixture.0, &path, "2.1.0", "aarch64").is_err());
        fs::remove_file(&path).unwrap();
        fixture.package("2.1.0", "arm64");
        let receipt = path.with_extension("dmg.completed.json");
        fs::remove_file(&receipt).unwrap();
        symlink(outside.with_extension("dmg.completed.json"), &receipt).unwrap();
        assert!(verified_dmg(&fixture.0, &path, "2.1.0", "aarch64").is_err());
        let nested = fixture.0.join("updates/nested");
        fs::create_dir(&nested).unwrap();
        assert!(verified_dmg(
            &fixture.0,
            &nested.join(path.file_name().unwrap()),
            "2.1.0",
            "aarch64"
        )
        .is_err());
        fs::remove_dir_all(fixture.0.join("updates")).unwrap();
        symlink(other.0.join("updates"), fixture.0.join("updates")).unwrap();
        assert!(verified_dmg(&fixture.0, &path, "2.1.0", "aarch64").is_err());
    }

    #[test]
    fn rejects_mismatched_or_malformed_download_receipts() {
        let fixture = Fixture::new();
        for (field, value) in [
            ("schema", serde_json::json!(2)),
            ("platform", serde_json::json!("win")),
            ("architecture", serde_json::json!("x64")),
            ("version", serde_json::json!("2.2.0")),
            ("fileName", serde_json::json!("other.dmg")),
            ("size", serde_json::json!(1)),
            ("sha256", serde_json::json!("not-a-digest")),
        ] {
            let path = fixture.package("2.1.0", "arm64");
            let receipt = path.with_extension("dmg.completed.json");
            let mut data: serde_json::Value =
                serde_json::from_slice(&fs::read(&receipt).unwrap()).unwrap();
            data[field] = value;
            fs::write(receipt, serde_json::to_vec(&data).unwrap()).unwrap();
            assert!(
                verified_dmg(&fixture.0, &path, "2.1.0", "aarch64").is_err(),
                "{field}"
            );
        }
        let path = fixture.package("2.1.0", "arm64");
        fs::write(path.with_extension("dmg.completed.json"), "{broken").unwrap();
        assert!(verified_dmg(&fixture.0, &path, "2.1.0", "aarch64").is_err());
    }
}
