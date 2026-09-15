use crate::{
    error::{Error, Result},
    model::{ChangedFile, ContextGap, DiffContext, DiffLine, FileDiff, FileKind},
    patch, Proof,
};

const CONTEXT_BYTE_LIMIT: usize = 4 * 1024 * 1024;
const CONTEXT_LINE_LIMIT: usize = 100_000;
const CONTEXT_CACHE_BYTES: usize = 8 * 1024 * 1024;

// Git accepts a signed 32-bit context size. Output is independently bounded
// before parsing, even when all unchanged lines are requested.
fn context_size_arg(lines: Option<u16>) -> u32 {
    match lines {
        None => i32::MAX as u32,
        // The original 3-line Review units stay intact. For 0..2, the reader
        // crops already captured unchanged lines without changing those units.
        Some(lines) => u32::from(lines.max(3)),
    }
}

impl Proof {
    pub fn diff_context(&mut self, snapshot_id: &str, context_lines: u16) -> Result<DiffContext> {
        self.read_diff_context(snapshot_id, Some(context_lines))
    }

    /// None requests all unchanged text surrounding the original Review units.
    pub fn read_diff_context(
        &mut self,
        snapshot_id: &str,
        context_lines: Option<u16>,
    ) -> Result<DiffContext> {
        let size = context_size_arg(context_lines);
        let diff = self.snapshot(snapshot_id)?;
        // Captured text remains readable after an edit, but a registration may
        // never resolve to a replaced physical repository.
        let workspace = self.store.workspace(&diff.workspace_id)?;
        if let Some(context) = self.cached_context(snapshot_id, context_lines) {
            return Ok(context);
        }
        ensure_text(&diff)?;
        let git = self.git()?;
        self.validate(&diff)?;
        let changes = git.changes(&workspace)?;
        let file = changes
            .files
            .iter()
            .find(|file| {
                file.path == diff.path && file.old_path == diff.old_path && file.side == diff.side
            })
            .ok_or_else(Error::stale)?;
        // Includes configuration and filters beyond the file's source guard.
        if git.patch_for_read(&workspace, file, crate::diff_load::read_limit(true))? != diff.patch {
            return Err(Error::stale());
        }
        let expanded = git
            .patch_context_for_read(&workspace, file, size, CONTEXT_BYTE_LIMIT)
            .map_err(context_limit_error)?;
        self.validate(&diff)?;
        let context = expanded_context(&diff, &expanded, context_lines)?;
        self.cache_context(context.clone());
        Ok(context)
    }

    /// Historical context uses frozen trees and a content-bound comparison ID;
    /// it is never registered as a mutable Worktree snapshot.
    pub fn compare_context(
        &mut self,
        workspace_id: &str,
        base: &str,
        target: &str,
        path: &str,
        snapshot_id: &str,
        context_lines: Option<u16>,
    ) -> Result<DiffContext> {
        let size = context_size_arg(context_lines);
        let workspace = self.store.workspace(workspace_id)?;
        // Re-read to reject changed comparison presentation/configuration.
        let diff = self.compare_file(workspace_id, base, target, path)?;
        if diff.id != snapshot_id {
            return Err(comparison_changed());
        }
        if let Some(context) = self.cached_context(snapshot_id, context_lines) {
            return Ok(context);
        }
        ensure_text(&diff)?;
        let file = ChangedFile {
            path: diff.path.clone(),
            old_path: diff.old_path.clone(),
            status: String::new(),
            side: diff.side,
            conflicted: false,
        };
        let expanded = crate::git::text(
            crate::compare::file_patch(
                &self.git()?,
                &workspace,
                base,
                target,
                &file,
                size,
                CONTEXT_BYTE_LIMIT,
            )
            .map_err(context_limit_error)?,
        )?;
        let context = expanded_context(&diff, &expanded, context_lines).map_err(|error| {
            if error.code == "STALE_CONTENT" {
                comparison_changed()
            } else {
                error
            }
        })?;
        self.cache_context(context.clone());
        Ok(context)
    }

    fn cached_context(&self, snapshot_id: &str, lines: Option<u16>) -> Option<DiffContext> {
        self.contexts
            .iter()
            .find(|c| {
                c.snapshot_id == snapshot_id
                    && c.full_file == lines.is_none()
                    && c.context_lines == lines.unwrap_or(3)
            })
            .cloned()
    }

    fn cache_context(&mut self, context: DiffContext) {
        self.contexts.push_back(context);
        while self.contexts.len() > 8
            || self.contexts.iter().map(retained_bytes).sum::<usize>() > CONTEXT_CACHE_BYTES
        {
            self.contexts.pop_front();
        }
    }
}

fn comparison_changed() -> Error {
    Error::new(
        "COMPARE_CHANGED",
        "比较内容已更新，请重新打开此 Diff。",
        "Comparison presentation changed",
    )
}
fn ensure_text(diff: &FileDiff) -> Result<()> {
    if !matches!(diff.kind, FileKind::Text | FileKind::Rename)
        || diff.hunks.iter().all(|hunk| hunk.lines.is_empty())
    {
        return Err(Error::new(
            "CONTEXT_UNAVAILABLE",
            "此文件使用专用摘要，请查看原始 patch。",
            diff.kind,
        ));
    }
    Ok(())
}
fn context_limit_error(error: Error) -> Error {
    if error.code == "DIFF_OUTPUT_LIMIT" {
        context_too_large()
    } else {
        error
    }
}
fn context_too_large() -> Error {
    Error::new(
        "CONTEXT_TOO_LARGE",
        "完整内容超过读取上限（4 MiB / 100,000 行）。请选择更少的上下文，或在外部编辑器中查找。",
        "Context output exceeds the bounded text reader",
    )
}
fn expanded_context(
    diff: &FileDiff,
    expanded: &str,
    context_lines: Option<u16>,
) -> Result<DiffContext> {
    if expanded.len() > CONTEXT_BYTE_LIMIT
        || expanded.lines().take(CONTEXT_LINE_LIMIT + 1).count() > CONTEXT_LINE_LIMIT
    {
        return Err(context_too_large());
    }
    let header = |text: &str| {
        text.split_inclusive('\n')
            .take_while(|line| !line.starts_with("@@ "))
            .collect::<String>()
    };
    if header(expanded) != header(&diff.patch) {
        return Err(Error::stale());
    }
    let expanded_hunks = patch::hunks(expanded, "read-only-context");
    let lines: Vec<DiffLine> = expanded_hunks.into_iter().flat_map(|h| h.lines).collect();
    let mut cursor = 0;
    let mut gaps = Vec::new();
    for hunk in diff.hunks.iter().filter(|h| !h.lines.is_empty()) {
        // A wide Git hunk may merge original units. Only unchanged lines enter
        // the gaps; original Hunk IDs and executable patches stay intact.
        let relative = lines[cursor..]
            .windows(hunk.lines.len())
            .position(|candidate| {
                candidate
                    .iter()
                    .zip(&hunk.lines)
                    .all(|(a, b)| same_line(a, b))
            })
            .ok_or_else(context_mismatch)?;
        let start = cursor + relative;
        gaps.push(gap(Some(hunk.id.clone()), &lines[cursor..start])?);
        cursor = start + hunk.lines.len();
    }
    gaps.push(gap(None, &lines[cursor..])?);
    Ok(DiffContext {
        snapshot_id: diff.id.clone(),
        context_lines: context_lines.unwrap_or(3),
        full_file: context_lines.is_none(),
        gaps,
    })
}

fn same_line(a: &DiffLine, b: &DiffLine) -> bool {
    a.kind == b.kind
        && a.old_line == b.old_line
        && a.new_line == b.new_line
        && a.content == b.content
}
fn context_mismatch() -> Error {
    Error::new(
        "CONTEXT_MISMATCH",
        "扩展内容无法与原始变化块对应，请刷新后重试。原始 Diff 保持不变。",
        "Expanded context does not preserve the original review units",
    )
}
fn gap(before_hunk_id: Option<String>, lines: &[DiffLine]) -> Result<ContextGap> {
    if lines
        .iter()
        .any(|line| !matches!(line.kind.as_str(), "context" | "note"))
    {
        return Err(context_mismatch());
    }
    Ok(ContextGap {
        before_hunk_id,
        lines: lines.to_vec(),
    })
}
fn retained_bytes(context: &DiffContext) -> usize {
    std::mem::size_of::<DiffContext>()
        + context.snapshot_id.capacity()
        + context.gaps.capacity() * std::mem::size_of::<ContextGap>()
        + context
            .gaps
            .iter()
            .map(|gap| {
                gap.before_hunk_id.as_ref().map_or(0, String::capacity)
                    + gap.lines.capacity() * std::mem::size_of::<DiffLine>()
                    + gap
                        .lines
                        .iter()
                        .map(|l| l.kind.capacity() + l.content.capacity())
                        .sum::<usize>()
            })
            .sum::<usize>()
}
