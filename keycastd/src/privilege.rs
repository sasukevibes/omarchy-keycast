//! Privilege handling for runs started through pkexec, and the recording gate.
//!
//! The helper is root only long enough to open /dev/input nodes. After that it
//! becomes the user who invoked pkexec, and while it was privileged it only
//! keeps running while that user has gpu-screen-recorder running.

use std::fs;
use std::io;

const RECORDER: &str = "gpu-screen-recorder";

pub fn running_as_root() -> bool {
    unsafe { libc::geteuid() == 0 }
}

/// The uid to become when running as root. Only PKEXEC_UID is trusted:
/// pkexec sets it itself and scrubs the rest of the environment.
pub fn pkexec_uid() -> Option<libc::uid_t> {
    std::env::var("PKEXEC_UID").ok()?.parse().ok()
}

fn primary_gid(uid: libc::uid_t) -> io::Result<libc::gid_t> {
    let mut pwd: libc::passwd = unsafe { std::mem::zeroed() };
    let mut buf = vec![0 as libc::c_char; 4096];
    let mut result: *mut libc::passwd = std::ptr::null_mut();
    let rc = unsafe { libc::getpwuid_r(uid, &mut pwd, buf.as_mut_ptr(), buf.len(), &mut result) };
    if rc != 0 || result.is_null() {
        return Err(io::Error::other(format!("no passwd entry for uid {uid}")));
    }
    Ok(pwd.pw_gid)
}

/// Permanently switch every uid and gid to `uid`, dropping supplementary
/// groups, and verify root cannot be regained.
pub fn drop_to(uid: libc::uid_t) -> io::Result<()> {
    let gid = primary_gid(uid)?;
    unsafe {
        if libc::setgroups(0, std::ptr::null()) != 0
            || libc::setresgid(gid, gid, gid) != 0
            || libc::setresuid(uid, uid, uid) != 0
        {
            return Err(io::Error::last_os_error());
        }
        if libc::geteuid() != uid || libc::getegid() != gid || libc::setuid(0) == 0 {
            return Err(io::Error::other("privileges were not fully dropped"));
        }
    }
    Ok(())
}

/// Die with the process that started us. Must be called after drop_to,
/// because changing credentials clears the parent-death signal.
pub fn die_with_parent() {
    unsafe {
        libc::prctl(libc::PR_SET_PDEATHSIG, libc::SIGTERM as libc::c_ulong, 0, 0, 0);
        if libc::getppid() == 1 {
            std::process::exit(0);
        }
    }
}

pub fn current_uid() -> libc::uid_t {
    unsafe { libc::getuid() }
}

/// Is a gpu-screen-recorder process owned by `uid` running?
pub fn recording_active(uid: libc::uid_t) -> bool {
    let Ok(entries) = fs::read_dir("/proc") else { return false };
    entries.flatten().any(|entry| {
        let name = entry.file_name();
        let Some(pid) = name.to_str().filter(|s| s.bytes().all(|b| b.is_ascii_digit())) else {
            return false;
        };
        is_recorder(pid) && owner(pid) == Some(uid)
    })
}

fn is_recorder(pid: &str) -> bool {
    let Ok(cmdline) = fs::read(format!("/proc/{pid}/cmdline")) else { return false };
    let argv0 = cmdline.split(|b| *b == 0).next().unwrap_or_default();
    argv0.rsplit(|b| *b == b'/').next() == Some(RECORDER.as_bytes())
}

fn owner(pid: &str) -> Option<libc::uid_t> {
    let status = fs::read_to_string(format!("/proc/{pid}/status")).ok()?;
    let line = status.lines().find(|l| l.starts_with("Uid:"))?;
    line.split_whitespace().nth(1)?.parse().ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn no_recorder_for_nonexistent_user() {
        assert!(!recording_active(u32::MAX - 1));
    }

    #[test]
    fn primary_gid_resolves_current_user() {
        assert!(primary_gid(current_uid()).is_ok());
    }
}
