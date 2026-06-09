//! Install the app's bundled Claude Code skills into `~/.claude/skills`.
//!
//! The chat driver spawns the host `claude` CLI, which discovers skills from
//! `~/.claude/skills/` (the cadcode generator is even invoked by absolute path,
//! `python ~/.claude/skills/cadcode/scripts/cad <file>` — see
//! [`crate::commands::claude_driver`]). The skills ship inside the app bundle
//! via `tauri.conf.json` → `bundle.resources`; on startup we copy each one into
//! place so a fresh install has `cadcode` et al. available without any manual
//! step.
//!
//! Two rules keep this friendly to both end users and developers:
//!
//! - A destination skill dir that is a **symlink** is left untouched. That is
//!   the supported dev override — point `~/.claude/skills/cadcode` at the repo
//!   and live-edit it (the same thing `scripts/dev.sh` users do by hand).
//! - Otherwise the copy is refreshed only when the app version changes, tracked
//!   by a `.panda-skill-version` stamp written into each installed skill dir.
//!   App-managed copies are overwritten on upgrade; manual edits to a non-symlinked
//!   copy are not preserved (symlink if you want to edit).

use std::fs;
use std::io;
use std::path::{Path, PathBuf};

/// Stamp file written into each installed skill dir to record the app version
/// that produced it. Gates the per-launch refresh.
const VERSION_STAMP: &str = ".panda-skill-version";

/// Resolve where the bundled skills live: the packaged resource dir in a real
/// install, falling back to the repo `skills/` tree when running from
/// `cargo run` in dev (the resource dir has no skills there).
pub fn bundled_skills_dir(app: &tauri::AppHandle) -> Option<PathBuf> {
    use tauri::Manager;
    if let Ok(res) = app.path().resource_dir() {
        let packaged = res.join("skills");
        if packaged.is_dir() {
            return Some(packaged);
        }
    }
    // Dev fallback: `cargo run` from the repo. CARGO_MANIFEST_DIR is the
    // `desktop/src-tauri` crate dir; the skills tree is two levels up. In a
    // real bundle this baked-in build path won't exist, so we only reach it
    // in dev (and the resource dir wins above regardless).
    let dev = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../skills");
    dev.is_dir().then_some(dev)
}

/// Install/refresh every bundled skill into `~/.claude/skills`. Best-effort:
/// any failure is logged and swallowed so a skill-install hiccup never blocks
/// app launch.
pub fn install_bundled_skills(app: &tauri::AppHandle) {
    let Some(src) = bundled_skills_dir(app) else {
        eprintln!("[panda] no bundled skills found; skipping skill install");
        return;
    };
    let Some(home) = std::env::var_os("HOME").map(PathBuf::from) else {
        eprintln!("[panda] HOME unset; skipping skill install");
        return;
    };
    let dst = home.join(".claude").join("skills");
    match sync_skill_trees(&src, &dst, env!("CARGO_PKG_VERSION")) {
        Ok(installed) if !installed.is_empty() => {
            eprintln!("[panda] installed/updated skills: {}", installed.join(", "));
        }
        Ok(_) => {}
        Err(e) => eprintln!("[panda] skill install failed: {e}"),
    }
}

/// Pure core: copy each immediate sub-directory of `src_root` into
/// `dst_root/<name>`, skipping any destination that is a symlink (dev override)
/// and any that already carries the current `version` stamp. Returns the names
/// that were (re)installed.
pub fn sync_skill_trees(
    src_root: &Path,
    dst_root: &Path,
    version: &str,
) -> io::Result<Vec<String>> {
    fs::create_dir_all(dst_root)?;
    let mut installed = Vec::new();
    for entry in fs::read_dir(src_root)? {
        let entry = entry?;
        if !entry.file_type()?.is_dir() {
            continue;
        }
        let name = entry.file_name();
        let src = entry.path();
        let dst = dst_root.join(&name);

        // Respect a symlinked skill dir: a dev is pointing it at the repo for
        // live editing. `symlink_metadata` does not follow the link.
        if let Ok(meta) = fs::symlink_metadata(&dst) {
            if meta.file_type().is_symlink() {
                continue;
            }
        }
        if is_up_to_date(&dst, version) {
            continue;
        }
        if dst.exists() {
            fs::remove_dir_all(&dst)?;
        }
        copy_dir_all(&src, &dst)?;
        fs::write(dst.join(VERSION_STAMP), version)?;
        installed.push(name.to_string_lossy().into_owned());
    }
    Ok(installed)
}

/// Write `~/.claude/panda-mcp-config.json` with an empty `mcpServers` map.
///
/// This file is passed as `--mcp-config` to every spawned `claude -p` subprocess
/// so that the user's globally-configured MCP servers (e.g. a Reminders or
/// Calendar integration) cannot start inside Panda's sandboxed turns and trigger
/// unexpected macOS privacy permission dialogs. Best-effort: a write failure is
/// logged and swallowed — it must never block a chat turn.
pub fn install_panda_mcp_config() {
    let Some(home) = std::env::var_os("HOME")
        .or_else(|| std::env::var_os("USERPROFILE"))
        .map(PathBuf::from)
    else {
        eprintln!("[panda] HOME unset; skipping panda-mcp-config install");
        return;
    };
    let path = home.join(".claude").join("panda-mcp-config.json");
    // Idempotent: skip if the file already exists (content never changes).
    if path.exists() {
        return;
    }
    if let Some(parent) = path.parent() {
        if let Err(e) = fs::create_dir_all(parent) {
            eprintln!("[panda] panda-mcp-config install failed (mkdir): {e}");
            return;
        }
    }
    if let Err(e) = fs::write(&path, r#"{"mcpServers":{}}"#) {
        eprintln!("[panda] panda-mcp-config install failed (write): {e}");
    }
}

/// True when `dst` already holds a stamp matching `version`.
fn is_up_to_date(dst: &Path, version: &str) -> bool {
    fs::read_to_string(dst.join(VERSION_STAMP))
        .map(|s| s.trim() == version)
        .unwrap_or(false)
}

/// Recursively copy `src` into `dst`. `is_dir()` / `fs::copy` both follow
/// symlinks, which is fine — skill trees are plain files and directories.
fn copy_dir_all(src: &Path, dst: &Path) -> io::Result<()> {
    fs::create_dir_all(dst)?;
    for entry in fs::read_dir(src)? {
        let entry = entry?;
        let from = entry.path();
        let to = dst.join(entry.file_name());
        if from.is_dir() {
            copy_dir_all(&from, &to)?;
        } else {
            fs::copy(&from, &to)?;
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn write(path: &Path, contents: &str) {
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, contents).unwrap();
    }

    #[test]
    fn copies_then_idempotent_then_refreshes_on_version_bump() {
        let tmp = tempfile::tempdir().unwrap();
        let src = tmp.path().join("src");
        let dst = tmp.path().join("dst");
        write(&src.join("cadcode/SKILL.md"), "v1");
        write(&src.join("cadcode/scripts/cad"), "#!/bin/sh");
        write(&src.join("gcode/SKILL.md"), "g");

        // First install copies both skills, stamps, and preserves the tree.
        let mut done = sync_skill_trees(&src, &dst, "1.0.0").unwrap();
        done.sort();
        assert_eq!(done, vec!["cadcode".to_string(), "gcode".to_string()]);
        assert_eq!(fs::read_to_string(dst.join("cadcode/SKILL.md")).unwrap(), "v1");
        assert!(dst.join("cadcode/scripts/cad").exists());

        // Same version → no work.
        assert!(sync_skill_trees(&src, &dst, "1.0.0").unwrap().is_empty());

        // Edit source + bump version → cadcode re-copied with new contents.
        write(&src.join("cadcode/SKILL.md"), "v2");
        let done2 = sync_skill_trees(&src, &dst, "1.1.0").unwrap();
        assert!(done2.contains(&"cadcode".to_string()));
        assert_eq!(fs::read_to_string(dst.join("cadcode/SKILL.md")).unwrap(), "v2");
    }

    #[test]
    fn stale_files_are_pruned_on_refresh() {
        let tmp = tempfile::tempdir().unwrap();
        let src = tmp.path().join("src");
        let dst = tmp.path().join("dst");
        write(&src.join("cadcode/old.py"), "x");
        sync_skill_trees(&src, &dst, "1.0.0").unwrap();
        assert!(dst.join("cadcode/old.py").exists());

        // Source drops old.py, adds new.py; a version bump should mirror that.
        fs::remove_file(src.join("cadcode/old.py")).unwrap();
        write(&src.join("cadcode/new.py"), "y");
        sync_skill_trees(&src, &dst, "2.0.0").unwrap();
        assert!(!dst.join("cadcode/old.py").exists(), "stale file must be pruned");
        assert!(dst.join("cadcode/new.py").exists());
    }

    #[cfg(unix)]
    #[test]
    fn leaves_symlinked_skill_untouched() {
        let tmp = tempfile::tempdir().unwrap();
        let src = tmp.path().join("src");
        let dst = tmp.path().join("dst");
        write(&src.join("cadcode/SKILL.md"), "bundled");

        // A dev symlink: dst/cadcode -> a live repo copy.
        let repo = tmp.path().join("repo_cadcode");
        write(&repo.join("SKILL.md"), "live-edit");
        fs::create_dir_all(&dst).unwrap();
        std::os::unix::fs::symlink(&repo, dst.join("cadcode")).unwrap();

        let done = sync_skill_trees(&src, &dst, "1.0.0").unwrap();
        assert!(
            !done.contains(&"cadcode".to_string()),
            "symlinked skill must be skipped",
        );
        // The symlink still resolves to the live repo copy, unmodified.
        assert_eq!(
            fs::read_to_string(dst.join("cadcode/SKILL.md")).unwrap(),
            "live-edit",
        );
    }
}
