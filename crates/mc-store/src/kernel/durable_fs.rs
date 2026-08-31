use std::ffi::OsStr;
use std::fs::File;
use std::io::{self, Write};
use std::os::unix::fs::FileExt;
use std::os::unix::fs::{MetadataExt, PermissionsExt};
use std::sync::atomic::{AtomicU64, Ordering};

use rustix::fs::{self as rfs, AtFlags, Mode, OFlags};

static UNIQUE_ID: AtomicU64 = AtomicU64::new(0);

#[derive(Debug)]
pub(super) enum StorageError {
    Exhausted(io::Error),
    Other(io::Error),
}

impl std::fmt::Display for StorageError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Exhausted(source) | Self::Other(source) => source.fmt(formatter),
        }
    }
}

impl std::error::Error for StorageError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            Self::Exhausted(source) | Self::Other(source) => Some(source),
        }
    }
}

impl StorageError {
    pub(super) fn raw_os_error(&self) -> Option<i32> {
        match self {
            Self::Exhausted(source) | Self::Other(source) => source.raw_os_error(),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum PublishOutcome {
    Published,
    AlreadyExists,
}

pub(super) fn classify_io(source: io::Error) -> StorageError {
    let exhausted = matches!(
        source.raw_os_error(),
        Some(code)
            if code == rustix::io::Errno::NOSPC.raw_os_error()
                || code == rustix::io::Errno::DQUOT.raw_os_error()
    );
    if exhausted {
        StorageError::Exhausted(source)
    } else {
        StorageError::Other(source)
    }
}

fn classify_errno(source: rustix::io::Errno) -> StorageError {
    classify_io(io::Error::from(source))
}

fn invalid_name() -> StorageError {
    classify_io(io::Error::new(
        io::ErrorKind::InvalidInput,
        "filesystem name must be one normal component",
    ))
}

fn validate_name(name: &str) -> Result<(), StorageError> {
    let path = std::path::Path::new(name);
    if name.is_empty() || name == "." || name == ".." || path.file_name() != Some(OsStr::new(name))
    {
        return Err(invalid_name());
    }
    Ok(())
}

pub(super) fn create_secure_directory(parent: &File, name: &str) -> Result<File, StorageError> {
    validate_name(name)?;
    rfs::mkdirat(parent, name, Mode::from_raw_mode(0o700)).map_err(classify_errno)?;
    rfs::chmodat(parent, name, Mode::from_raw_mode(0o700), AtFlags::empty())
        .map_err(classify_errno)?;
    let descriptor = rfs::openat(
        parent,
        name,
        OFlags::DIRECTORY | OFlags::RDONLY | OFlags::NOFOLLOW | OFlags::CLOEXEC,
        Mode::empty(),
    )
    .map_err(classify_errno)?;
    let directory = File::from(descriptor);
    let metadata = directory.metadata().map_err(classify_io)?;
    if !metadata.is_dir()
        || metadata.uid() != rustix::process::geteuid().as_raw()
        || metadata.permissions().mode() & 0o777 != 0o700
    {
        return Err(classify_io(io::Error::new(
            io::ErrorKind::PermissionDenied,
            "directory is not owner-only",
        )));
    }
    sync_directory(&directory)?;
    sync_directory(parent)?;
    Ok(directory)
}

pub(super) fn open_or_create_secure_directory(
    parent: &File,
    name: &str,
) -> Result<File, StorageError> {
    match create_secure_directory(parent, name) {
        Ok(directory) => Ok(directory),
        Err(StorageError::Other(source)) if source.kind() == io::ErrorKind::AlreadyExists => {
            open_secure_directory(parent, name)
        }
        Err(error) => Err(error),
    }
}

pub(super) fn open_secure_directory(parent: &File, name: &str) -> Result<File, StorageError> {
    validate_name(name)?;
    let descriptor = rfs::openat(
        parent,
        name,
        OFlags::DIRECTORY | OFlags::RDONLY | OFlags::NOFOLLOW | OFlags::CLOEXEC,
        Mode::empty(),
    )
    .map_err(classify_errno)?;
    let directory = File::from(descriptor);
    let metadata = directory.metadata().map_err(classify_io)?;
    if !metadata.is_dir()
        || metadata.uid() != rustix::process::geteuid().as_raw()
        || metadata.permissions().mode() & 0o777 != 0o700
    {
        return Err(classify_io(io::Error::new(
            io::ErrorKind::PermissionDenied,
            "directory is not owner-only",
        )));
    }
    Ok(directory)
}

pub(super) fn create_new_file(directory: &File, name: &str) -> Result<File, StorageError> {
    validate_name(name)?;
    let descriptor = rfs::openat(
        directory,
        name,
        OFlags::CREATE | OFlags::EXCL | OFlags::WRONLY | OFlags::NOFOLLOW | OFlags::CLOEXEC,
        Mode::from_raw_mode(0o600),
    )
    .map_err(classify_errno)?;
    rfs::fchmod(&descriptor, Mode::from_raw_mode(0o600)).map_err(classify_errno)?;
    Ok(File::from(descriptor))
}

pub(super) fn open_or_create_append_file(
    directory: &File,
    name: &str,
) -> Result<File, StorageError> {
    match create_new_file(directory, name) {
        Ok(file) => {
            sync_directory(directory)?;
            drop(file);
            open_or_create_append_file(directory, name)
        }
        Err(StorageError::Other(source)) if source.kind() == io::ErrorKind::AlreadyExists => {
            validate_name(name)?;
            let descriptor = rfs::openat(
                directory,
                name,
                OFlags::APPEND | OFlags::RDWR | OFlags::NOFOLLOW | OFlags::CLOEXEC,
                Mode::empty(),
            )
            .map_err(classify_errno)?;
            let file = File::from(descriptor);
            let metadata = file.metadata().map_err(classify_io)?;
            if !metadata.is_file()
                || metadata.uid() != rustix::process::geteuid().as_raw()
                || metadata.permissions().mode() & 0o777 != 0o600
            {
                return Err(classify_io(io::Error::new(
                    io::ErrorKind::PermissionDenied,
                    "append file is not owner-only",
                )));
            }
            Ok(file)
        }
        Err(error) => Err(error),
    }
}

pub(super) fn append_and_sync(file: &mut File, bytes: &[u8]) -> Result<(), StorageError> {
    let length = file.metadata().map_err(classify_io)?.len();
    if length > 0 {
        let mut last = [0_u8; 1];
        file.read_exact_at(&mut last, length - 1)
            .map_err(classify_io)?;
        if last[0] != b'\n' {
            file.write_all(b"\n").map_err(classify_io)?;
        }
    }
    file.write_all(bytes).map_err(classify_io)?;
    sync_file(file)
}

pub(super) fn open_regular_nofollow(directory: &File, name: &str) -> Result<File, StorageError> {
    validate_name(name)?;
    let descriptor = rfs::openat(
        directory,
        name,
        OFlags::RDONLY | OFlags::NOFOLLOW | OFlags::NONBLOCK | OFlags::CLOEXEC,
        Mode::empty(),
    )
    .map_err(classify_errno)?;
    let file = File::from(descriptor);
    let metadata = file.metadata().map_err(classify_io)?;
    if !metadata.file_type().is_file()
        || metadata.nlink() != 1
        || metadata.uid() != rustix::process::geteuid().as_raw()
        || metadata.permissions().mode() & 0o177 != 0o000
    {
        return Err(classify_io(io::Error::new(
            io::ErrorKind::InvalidData,
            "object is not an exclusively owned regular file",
        )));
    }
    Ok(file)
}

pub(super) fn write_and_sync(file: &mut File, bytes: &[u8]) -> Result<(), StorageError> {
    file.write_all(bytes).map_err(classify_io)?;
    sync_file(file)
}

fn sync_file(file: &File) -> Result<(), StorageError> {
    loop {
        match file.sync_all() {
            Ok(()) => return Ok(()),
            Err(error) if error.kind() == io::ErrorKind::Interrupted => {}
            Err(error) => return Err(classify_io(error)),
        }
    }
}

pub(super) fn sync_directory(directory: &File) -> Result<(), StorageError> {
    sync_file(directory)
}

fn sync_publish_directories_with(
    source_directory: &File,
    destination_directory: &File,
    mut sync: impl FnMut(&File) -> Result<(), StorageError>,
) -> Result<(), StorageError> {
    let source = source_directory.metadata().map_err(classify_io)?;
    let destination = destination_directory.metadata().map_err(classify_io)?;
    sync(destination_directory)?;
    if source.dev() != destination.dev() || source.ino() != destination.ino() {
        sync(source_directory)?;
    }
    Ok(())
}

pub(super) fn publish_noreplace_locked(
    directory: &File,
    temp_name: &str,
    final_name: &str,
) -> Result<PublishOutcome, StorageError> {
    publish_noreplace_between_locked(directory, temp_name, directory, final_name)
}

pub(super) fn publish_noreplace_between_locked(
    source_directory: &File,
    temp_name: &str,
    destination_directory: &File,
    final_name: &str,
) -> Result<PublishOutcome, StorageError> {
    validate_name(temp_name)?;
    validate_name(final_name)?;

    #[cfg(any(target_os = "linux", target_os = "macos"))]
    {
        match rfs::renameat_with(
            source_directory,
            temp_name,
            destination_directory,
            final_name,
            rfs::RenameFlags::NOREPLACE,
        ) {
            Ok(()) => {
                sync_publish_directories_with(
                    source_directory,
                    destination_directory,
                    sync_directory,
                )?;
                return Ok(PublishOutcome::Published);
            }
            Err(rustix::io::Errno::EXIST) | Err(rustix::io::Errno::NOTEMPTY) => {
                return Ok(PublishOutcome::AlreadyExists);
            }
            Err(rustix::io::Errno::INVAL)
            | Err(rustix::io::Errno::NOSYS)
            | Err(rustix::io::Errno::OPNOTSUPP) => {}
            Err(error) => return Err(classify_errno(error)),
        }
    }

    match rfs::statat(destination_directory, final_name, AtFlags::SYMLINK_NOFOLLOW) {
        Ok(_) => return Ok(PublishOutcome::AlreadyExists),
        Err(rustix::io::Errno::NOENT) => {}
        Err(error) => return Err(classify_errno(error)),
    }
    match rfs::renameat(
        source_directory,
        temp_name,
        destination_directory,
        final_name,
    ) {
        Ok(()) => {
            sync_publish_directories_with(source_directory, destination_directory, sync_directory)?;
            Ok(PublishOutcome::Published)
        }
        Err(rustix::io::Errno::EXIST) | Err(rustix::io::Errno::NOTEMPTY) => {
            Ok(PublishOutcome::AlreadyExists)
        }
        Err(error) => Err(classify_errno(error)),
    }
}

pub(super) fn durable_unlink(directory: &File, name: &str) -> Result<(), StorageError> {
    validate_name(name)?;
    match rfs::unlinkat(directory, name, AtFlags::empty()) {
        Ok(()) => sync_directory(directory),
        // A retry after `unlinkat` succeeded but `sync_directory` failed observes NOENT,
        // and the directory entry removal is still unsynced at that point.
        Err(rustix::io::Errno::NOENT) => sync_directory(directory),
        Err(error) => Err(classify_errno(error)),
    }
}

pub(super) fn temp_name(stem: &str) -> String {
    debug_assert!(validate_name(stem).is_ok());
    format!(".{stem}-{}.tmp", next_unique_id())
}

pub(super) fn next_unique_id() -> u64 {
    let counter = UNIQUE_ID.fetch_add(1, Ordering::Relaxed);
    (u64::from(std::process::id()) << 32) | counter
}

#[cfg(test)]
mod tests {
    use std::fs::{self, File};
    use std::io::Read;
    use std::os::unix::fs::{symlink, MetadataExt, PermissionsExt};

    use super::*;

    #[test]
    fn durable_publish_happy_path() {
        let root = tempfile::tempdir().unwrap();
        let root_dir = File::open(root.path()).unwrap();
        let directory = create_secure_directory(&root_dir, "objects").unwrap();
        let temp = temp_name("artifact");
        let mut file = create_new_file(&directory, &temp).unwrap();
        write_and_sync(&mut file, b"payload").unwrap();

        assert_eq!(
            publish_noreplace_locked(&directory, &temp, "digest").unwrap(),
            PublishOutcome::Published
        );

        let mut bytes = Vec::new();
        File::open(root.path().join("objects/digest"))
            .unwrap()
            .read_to_end(&mut bytes)
            .unwrap();
        assert_eq!(bytes, b"payload");
    }

    #[test]
    fn cross_directory_publish_syncs_destination_and_source() {
        let root = tempfile::tempdir().unwrap();
        let root_dir = File::open(root.path()).unwrap();
        let source = create_secure_directory(&root_dir, "tmp").unwrap();
        let destination = create_secure_directory(&root_dir, "shard").unwrap();
        let mut temp = create_new_file(&source, "artifact.tmp").unwrap();
        write_and_sync(&mut temp, b"payload").unwrap();
        let mut synced = Vec::new();

        sync_publish_directories_with(&source, &destination, |directory| {
            synced.push(directory.metadata().unwrap().ino());
            Ok(())
        })
        .unwrap();

        assert_eq!(
            synced,
            [
                destination.metadata().unwrap().ino(),
                source.metadata().unwrap().ino()
            ]
        );
        assert_eq!(
            publish_noreplace_between_locked(&source, "artifact.tmp", &destination, "digest")
                .unwrap(),
            PublishOutcome::Published
        );
        assert!(!root.path().join("tmp/artifact.tmp").exists());
        assert_eq!(
            fs::read(root.path().join("shard/digest")).unwrap(),
            b"payload"
        );
    }

    #[test]
    fn same_directory_publish_syncs_once() {
        let root = tempfile::tempdir().unwrap();
        let directory = File::open(root.path()).unwrap();
        let mut sync_count = 0;

        sync_publish_directories_with(&directory, &directory, |_| {
            sync_count += 1;
            Ok(())
        })
        .unwrap();

        assert_eq!(sync_count, 1);
    }

    #[test]
    fn occupied_publish_preserves_destination_and_temp() {
        let root = tempfile::tempdir().unwrap();
        let directory = File::open(root.path()).unwrap();
        let mut destination = create_new_file(&directory, "digest").unwrap();
        write_and_sync(&mut destination, b"old").unwrap();
        let mut temp = create_new_file(&directory, "temp").unwrap();
        write_and_sync(&mut temp, b"new").unwrap();

        assert_eq!(
            publish_noreplace_locked(&directory, "temp", "digest").unwrap(),
            PublishOutcome::AlreadyExists
        );
        assert_eq!(fs::read(root.path().join("digest")).unwrap(), b"old");
        assert_eq!(fs::read(root.path().join("temp")).unwrap(), b"new");
    }

    #[test]
    fn durable_unlink_is_idempotent_when_absent() {
        let root = tempfile::tempdir().unwrap();
        let directory = File::open(root.path()).unwrap();

        durable_unlink(&directory, "missing").unwrap();
        let mut file = create_new_file(&directory, "present").unwrap();
        write_and_sync(&mut file, b"payload").unwrap();
        durable_unlink(&directory, "present").unwrap();
        durable_unlink(&directory, "present").unwrap();

        assert!(!root.path().join("present").exists());
    }

    #[test]
    fn append_log_is_owner_only_and_isolates_an_unterminated_tail() {
        let root = tempfile::tempdir().unwrap();
        let directory = File::open(root.path()).unwrap();
        let mut log = open_or_create_append_file(&directory, "intent.jsonl").unwrap();

        append_and_sync(&mut log, b"partial").unwrap();
        append_and_sync(&mut log, b"{\"next\":true}\n").unwrap();

        assert_eq!(
            fs::read(root.path().join("intent.jsonl")).unwrap(),
            b"partial\n{\"next\":true}\n"
        );
        assert_eq!(
            fs::metadata(root.path().join("intent.jsonl"))
                .unwrap()
                .permissions()
                .mode()
                & 0o777,
            0o600
        );
    }

    #[test]
    fn storage_errors_separate_exhaustion_from_other_io() {
        for errno in [rustix::io::Errno::NOSPC, rustix::io::Errno::DQUOT] {
            assert!(matches!(
                classify_io(std::io::Error::from_raw_os_error(errno.raw_os_error())),
                StorageError::Exhausted(_)
            ));
        }
        assert!(matches!(
            classify_io(std::io::Error::from_raw_os_error(
                rustix::io::Errno::IO.raw_os_error()
            )),
            StorageError::Other(_)
        ));
    }

    #[test]
    fn exclusive_create_refuses_symlink_destination() {
        let root = tempfile::tempdir().unwrap();
        let directory = File::open(root.path()).unwrap();
        fs::write(root.path().join("target"), b"untouched").unwrap();
        symlink("target", root.path().join("link")).unwrap();

        assert!(create_new_file(&directory, "link").is_err());
        assert_eq!(fs::read(root.path().join("target")).unwrap(), b"untouched");
    }

    #[test]
    fn secure_directory_creation_refuses_symlink_destination() {
        let root = tempfile::tempdir().unwrap();
        let root_dir = File::open(root.path()).unwrap();
        fs::create_dir(root.path().join("target")).unwrap();
        symlink("target", root.path().join("link")).unwrap();

        assert!(create_secure_directory(&root_dir, "link").is_err());
    }

    #[test]
    fn created_directories_and_files_are_owner_only() {
        let root = tempfile::tempdir().unwrap();
        let root_dir = File::open(root.path()).unwrap();
        let directory = create_secure_directory(&root_dir, "objects").unwrap();
        let file = create_new_file(&directory, "artifact").unwrap();

        assert_eq!(
            fs::metadata(root.path().join("objects"))
                .unwrap()
                .permissions()
                .mode()
                & 0o777,
            0o700
        );
        assert_eq!(file.metadata().unwrap().mode() & 0o777, 0o600);
        assert_eq!(
            file.metadata().unwrap().uid(),
            rustix::process::geteuid().as_raw()
        );
    }
}
