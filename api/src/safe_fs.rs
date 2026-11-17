//! Filesystem adapter checks for portable package publication. Domain records
//! never contain these handles or host filesystem identities.
use crate::error::{EngineError, ErrorCode, Result};
use std::{
    fs::{self, File, OpenOptions},
    io::{Read, Write},
    path::{Component, Path, PathBuf},
};
use uuid::Uuid;

pub fn io(error: std::io::Error) -> EngineError {
    EngineError {
        code: ErrorCode::Internal,
        message: error.to_string(),
    }
}
fn invalid(message: &str) -> EngineError {
    EngineError::invalid(message)
}
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Identity {
    volume: u64,
    index: u64,
}

pub fn absolute(path: &Path) -> Result<PathBuf> {
    let path = std::path::absolute(path).map_err(io)?;
    let mut result = PathBuf::new();
    for part in path.components() {
        match part {
            Component::CurDir => {}
            Component::ParentDir => {
                result.pop();
            }
            _ => result.push(part.as_os_str()),
        }
    }
    Ok(result)
}
fn comparison(path: &Path) -> String {
    #[cfg(windows)]
    {
        let value = path.to_string_lossy().replace('/', "\\");
        if let Some(unc) = value.strip_prefix("\\\\?\\UNC\\") {
            format!("\\\\{unc}").to_lowercase()
        } else {
            value
                .strip_prefix("\\\\?\\")
                .unwrap_or(&value)
                .to_lowercase()
        }
    }
    #[cfg(not(windows))]
    {
        path.to_string_lossy().into_owned()
    }
}
pub fn contained(root: &Path, candidate: &Path) -> bool {
    let root = comparison(root);
    let candidate = comparison(candidate);
    let separator = if cfg!(windows) { '\\' } else { '/' };
    candidate == root
        || candidate
            .starts_with(&(root.trim_end_matches(separator).to_owned() + &separator.to_string()))
}
pub fn symlink(metadata: &fs::Metadata) -> bool {
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        metadata.file_attributes() & 0x400 != 0
    }
    #[cfg(not(windows))]
    {
        metadata.file_type().is_symlink()
    }
}
pub fn assert_no_symlink_components(path: &Path) -> Result<()> {
    let mut cursor = PathBuf::new();
    for part in path.components() {
        cursor.push(part.as_os_str());
        match fs::symlink_metadata(&cursor) {
            Ok(metadata) if symlink(&metadata) => {
                return Err(invalid(
                    "Import target paths may not contain symbolic links.",
                ));
            }
            Ok(_) => {}
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(()),
            Err(e) => return Err(io(e)),
        }
    }
    Ok(())
}
pub fn absent(path: &Path) -> Result<()> {
    match fs::symlink_metadata(path) {
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(io(e)),
        Ok(_) => Err(EngineError {
            code: ErrorCode::Internal,
            message: format!("Import target already exists: {}", path.display()),
        }),
    }
}

/// Publish a fully staged directory on the same filesystem. Destination
/// collision is checked by the OS in the rename, not by a preceding exists().
pub fn publish_directory(staged: &Path, target: &Path) -> Result<()> {
    assert_no_symlink_components(staged)?;
    assert_no_symlink_components(target)?;
    #[cfg(windows)]
    {
        use std::os::windows::ffi::OsStrExt;
        use windows_sys::Win32::Storage::FileSystem::MoveFileExW;
        let from = staged
            .as_os_str()
            .encode_wide()
            .chain(Some(0))
            .collect::<Vec<_>>();
        let to = target
            .as_os_str()
            .encode_wide()
            .chain(Some(0))
            .collect::<Vec<_>>();
        // No REPLACE_EXISTING flag: even a racing empty directory is preserved.
        if unsafe { MoveFileExW(from.as_ptr(), to.as_ptr(), 0) } == 0 {
            return Err(io(std::io::Error::last_os_error()));
        }
        Ok(())
    }
    #[cfg(target_os = "linux")]
    {
        use std::{ffi::CString, os::unix::ffi::OsStrExt};
        let from = CString::new(staged.as_os_str().as_bytes())
            .map_err(|_| invalid("Invalid staging path."))?;
        let to = CString::new(target.as_os_str().as_bytes())
            .map_err(|_| invalid("Invalid target path."))?;
        if unsafe {
            libc::renameat2(
                libc::AT_FDCWD,
                from.as_ptr(),
                libc::AT_FDCWD,
                to.as_ptr(),
                libc::RENAME_NOREPLACE,
            )
        } != 0
        {
            return Err(io(std::io::Error::last_os_error()));
        }
        Ok(())
    }
    #[cfg(not(any(windows, target_os = "linux")))]
    {
        let _ = (staged, target);
        Err(invalid(
            "Atomic workspace publication is supported on Windows and Linux.",
        ))
    }
}
pub fn open_no_follow(path: &Path, directory: bool) -> Result<File> {
    let mut options = OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK);
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        use windows_sys::Win32::Storage::FileSystem::{
            FILE_FLAG_BACKUP_SEMANTICS, FILE_FLAG_OPEN_REPARSE_POINT,
        };
        options.custom_flags(
            FILE_FLAG_OPEN_REPARSE_POINT
                | if directory {
                    FILE_FLAG_BACKUP_SEMANTICS
                } else {
                    0
                },
        );
    }
    let file = options.open(path).map_err(io)?;
    let metadata = file.metadata().map_err(io)?;
    if symlink(&metadata)
        || if directory {
            !metadata.is_dir()
        } else {
            !metadata.is_file()
        }
    {
        return Err(invalid("Package source entry changed during copy."));
    }
    Ok(file)
}
fn file_info(file: &File) -> Result<(Identity, u64)> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        let meta = file.metadata().map_err(io)?;
        Ok((
            Identity {
                volume: meta.dev(),
                index: meta.ino(),
            },
            meta.nlink(),
        ))
    }
    #[cfg(windows)]
    {
        use std::os::windows::io::AsRawHandle;
        use windows_sys::Win32::Storage::FileSystem::{
            BY_HANDLE_FILE_INFORMATION, GetFileInformationByHandle,
        };
        let mut info = std::mem::MaybeUninit::<BY_HANDLE_FILE_INFORMATION>::uninit();
        // The handle remains alive for this call; the initialized structure is
        // read only after Windows reports success.
        let success =
            unsafe { GetFileInformationByHandle(file.as_raw_handle(), info.as_mut_ptr()) };
        if success == 0 {
            return Err(io(std::io::Error::last_os_error()));
        }
        let info = unsafe { info.assume_init() };
        Ok((
            Identity {
                volume: info.dwVolumeSerialNumber as u64,
                index: ((info.nFileIndexHigh as u64) << 32) | info.nFileIndexLow as u64,
            },
            info.nNumberOfLinks as u64,
        ))
    }
}
pub fn identity(path: &Path, directory: bool) -> Result<Identity> {
    file_info(&open_no_follow(path, directory)?).map(|v| v.0)
}
pub fn private_file_identity(path: &Path) -> Result<Identity> {
    let file = open_no_follow(path, false)?;
    let (identity, links) = file_info(&file)?;
    if links > 1 {
        return Err(invalid("Data path must be a private regular file."));
    }
    Ok(identity)
}
pub fn exclusive_file(path: &Path) -> Result<File> {
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    options.open(path).map_err(io)
}
fn directory(path: &Path) -> Result<()> {
    #[cfg(unix)]
    let mut builder = fs::DirBuilder::new();
    #[cfg(not(unix))]
    let builder = fs::DirBuilder::new();
    #[cfg(unix)]
    {
        use std::os::unix::fs::DirBuilderExt;
        builder.mode(0o700);
    }
    builder.create(path).map_err(io)
}
pub fn read_regular(path: &Path, reject_hardlinks: bool) -> Result<Vec<u8>> {
    let mut file = open_no_follow(path, false)?;
    if reject_hardlinks && file_info(&file)?.1 > 1 {
        return Err(invalid("Package source entry changed during copy."));
    }
    let mut data = Vec::new();
    file.read_to_end(&mut data).map_err(io)?;
    Ok(data)
}
pub fn read_regular_bounded(path: &Path, limit: usize) -> Result<Vec<u8>> {
    let file = open_no_follow(path, false)?;
    if file_info(&file)?.1 > 1 {
        return Err(invalid("Archive entries must be private regular files."));
    }
    if file.metadata().map_err(io)?.len() > limit as u64 {
        return Err(invalid("Archive entry exceeds its size limit."));
    }
    let mut data = Vec::new();
    file.take(limit as u64 + 1)
        .read_to_end(&mut data)
        .map_err(io)?;
    if data.len() > limit {
        return Err(invalid("Archive entry grew beyond its size limit."));
    }
    Ok(data)
}
pub fn write_private_regular(path: &Path, text: &[u8]) -> Result<()> {
    let mut options = OpenOptions::new();
    options.write(true).create(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options
            .mode(0o600)
            .custom_flags(libc::O_NONBLOCK | libc::O_NOFOLLOW);
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        options.custom_flags(windows_sys::Win32::Storage::FileSystem::FILE_FLAG_OPEN_REPARSE_POINT);
    }
    let mut file = options.open(path).map_err(io)?;
    let metadata = file.metadata().map_err(io)?;
    if !metadata.is_file() || symlink(&metadata) || file_info(&file)?.1 > 1 {
        return Err(invalid("Source path must be a private regular file."));
    }
    file.set_len(0).map_err(io)?;
    file.write_all(text).map_err(io)
}
pub fn copy_regular(source: &Path, target: &Path) -> Result<()> {
    copy_regular_with(source, target, true)
}
pub fn copy_export_regular(source: &Path, target: &Path) -> Result<()> {
    copy_regular_with(source, target, false)
}
fn copy_regular_with(source: &Path, target: &Path, reject_hardlinks: bool) -> Result<()> {
    let mut input = open_no_follow(source, false)?;
    if reject_hardlinks && file_info(&input)?.1 > 1 {
        return Err(invalid("Package source entry changed during copy."));
    }
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
        options.mode(input.metadata().map_err(io)?.permissions().mode() & 0o777);
    }
    let mut output = options.open(target).map_err(io)?;
    std::io::copy(&mut input, &mut output).map_err(io)?;
    Ok(())
}

pub struct SourceClaim {
    pub target: PathBuf,
    identity: Identity,
    marker: PathBuf,
    token: String,
}
impl SourceClaim {
    pub fn create(target: &Path) -> Result<Self> {
        assert_no_symlink_components(target)?;
        directory(target)?;
        let id = identity(target, true)?;
        let token = Uuid::new_v4().to_string();
        let marker = target.join(format!(".doxvelt-import-{token}"));
        let result = (|| {
            exclusive_file(&marker)?
                .write_all(token.as_bytes())
                .map_err(io)?;
            Ok(Self {
                target: target.into(),
                identity: id,
                marker: marker.clone(),
                token,
            })
        })();
        if result.is_err() && identity(target, true).is_ok_and(|current| current == id) {
            let _ = fs::remove_file(marker);
            let _ = fs::remove_dir(target);
        }
        result
    }
    fn owns_at(&self, path: &Path) -> bool {
        identity(path, true).is_ok_and(|id| id == self.identity)
            && self.marker.file_name().is_some_and(|name| {
                read_regular(&path.join(name), false)
                    .is_ok_and(|data| data == self.token.as_bytes())
            })
    }
    pub fn assert_owned(&self) -> Result<()> {
        assert_no_symlink_components(&self.target)?;
        if !self.owns_at(&self.target) {
            return Err(invalid("Import source target ownership was lost."));
        }
        Ok(())
    }
    pub fn finish(&self) -> Result<()> {
        self.assert_owned()?;
        fs::remove_file(&self.marker).map_err(io)
    }
    pub fn cleanup(&self) {
        let Some(parent) = self.target.parent() else {
            return;
        };
        if assert_no_symlink_components(parent).is_err() {
            return;
        }
        let candidates = std::iter::once(self.target.clone()).chain(
            fs::read_dir(parent)
                .into_iter()
                .flatten()
                .filter_map(|e| e.ok().map(|e| e.path())),
        );
        for candidate in candidates {
            // Only delete the directory this operation created, still under
            // the explicitly selected parent. Never remove its replacement.
            let Ok(resolved) = absolute(&candidate) else {
                continue;
            };
            let Ok(resolved_parent) = absolute(parent) else {
                continue;
            };
            if resolved != resolved_parent
                && contained(&resolved_parent, &resolved)
                && self.owns_at(&resolved)
            {
                let _ = fs::remove_dir_all(resolved);
                return;
            }
        }
    }
}
pub struct DatabaseClaim {
    target: PathBuf,
    identity: Identity,
    file: Option<File>,
}
impl DatabaseClaim {
    pub fn create(path: &Path) -> Result<Self> {
        assert_no_symlink_components(path)?;
        let file = exclusive_file(path)?;
        let id = file_info(&file)?.0;
        Ok(Self {
            target: path.into(),
            identity: id,
            file: Some(file),
        })
    }
    fn owned(&self) -> bool {
        identity(&self.target, false).is_ok_and(|id| id == self.identity)
    }
    pub fn write(&mut self, data: &[u8]) -> Result<()> {
        if !self.owned() {
            return Err(invalid("Import database target ownership was lost."));
        }
        let file = self
            .file
            .as_mut()
            .ok_or_else(|| invalid("Import database target claim is unavailable."))?;
        file.write_all(data).map_err(io)?;
        file.sync_all().map_err(io)?;
        if !self.owned() {
            return Err(invalid("Import database target ownership was lost."));
        }
        self.file.take();
        Ok(())
    }
    pub fn cleanup(&mut self) {
        self.file.take();
        if self.owned() {
            let _ = fs::remove_file(&self.target);
        }
    }
}
pub struct TempDirectory {
    claim: SourceClaim,
    retained: bool,
}
impl TempDirectory {
    pub fn create(parent: &Path, prefix: &str) -> Result<Self> {
        Ok(Self {
            claim: SourceClaim::create(&parent.join(format!("{prefix}{}", Uuid::new_v4())))?,
            retained: false,
        })
    }
    pub fn path(&self) -> &Path {
        &self.claim.target
    }
    /// A committed application record now owns this allocation. Removing a
    /// leftover claim marker must never put its referenced source at risk.
    pub fn retain(mut self) -> PathBuf {
        self.retained = true;
        let _ = self.claim.finish();
        self.claim.target.clone()
    }
}
impl Drop for TempDirectory {
    fn drop(&mut self) {
        if !self.retained {
            self.claim.cleanup();
        }
    }
}

pub fn copy_verified(source: &Path, target: &Path) -> Result<()> {
    open_no_follow(source, true)?;
    let trusted = fs::canonicalize(source).map_err(io)?;
    directory(target)?;
    copy_verified_directory(source, target, &trusted, None)
}
pub fn copy_verified_directory(
    source: &Path,
    target: &Path,
    trusted: &Path,
    claim: Option<&SourceClaim>,
) -> Result<()> {
    if let Some(claim) = claim {
        claim.assert_owned()?;
    }
    if !contained(trusted, &fs::canonicalize(source).map_err(io)?) {
        return Err(invalid("Package source escapes its source directory."));
    }
    for entry in fs::read_dir(source).map_err(io)? {
        let entry = entry.map_err(io)?;
        if let Some(claim) = claim {
            claim.assert_owned()?;
        }
        let source = entry.path();
        let target = target.join(entry.file_name());
        let metadata = fs::symlink_metadata(&source).map_err(io)?;
        if symlink(&metadata) {
            return Err(invalid("Package source may not contain symlinks."));
        }
        if !contained(trusted, &fs::canonicalize(&source).map_err(io)?) {
            return Err(invalid("Package source escapes its source directory."));
        }
        if metadata.is_dir() {
            directory(&target)?;
            copy_verified_directory(&source, &target, trusted, claim)?;
        } else if metadata.is_file() {
            copy_regular(&source, &target)?;
        } else {
            return Err(invalid(
                "Package source may contain only regular files and directories.",
            ));
        }
        if let Some(claim) = claim {
            claim.assert_owned()?;
        }
    }
    Ok(())
}
