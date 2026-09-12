use crate::{
    error::{Error, Result},
    model::{ContextGap, DiffContext, DiffLine, FileKind},
    patch, Proof,
};

const CONTEXT_BYTE_LIMIT: usize = 4 * 1024 * 1024;
const CONTEXT_CACHE_BYTES: usize = 8 * 1024 * 1024;

impl Proof {
    pub fn diff_context(&mut self, snapshot_id: &str, context_lines: u16) -> Result<DiffContext> {
        if ![3, 10, 25, 100].contains(&context_lines) {
            return Err(Error::new(
                "INVALID_CONTEXT_SIZE",
                "请选择 3、10、25 或 100 行上下文。",
                context_lines,
            ));
        }
        let diff = self.snapshot(snapshot_id)?;
        // A captured context remains readable after source changes, but an old
        // registration may never resolve to a replaced physical repository.
        let workspace = self.store.workspace(&diff.workspace_id)?;
        if let Some(cached) = self
            .contexts
            .iter()
            .find(|c| c.snapshot_id == snapshot_id && c.context_lines == context_lines)
        {
            return Ok(cached.clone());
        }
        if !matches!(diff.kind, FileKind::Text | FileKind::Rename) {
            return Err(Error::new(
                "CONTEXT_UNAVAILABLE",
                "此文件使用专用摘要，请查看原始 patch。",
                diff.kind,
            ));
        }
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
        // Check the actual original patch as well as source/index bytes. This
        // catches attribute/filter/config changes outside the file guard.
        if git.patch(&workspace, file)? != diff.patch {
            return Err(Error::stale());
        }
        let expanded = git.patch_with_context(&workspace, file, context_lines)?;
        self.validate(&diff)?;
        if expanded.len() > CONTEXT_BYTE_LIMIT {
            return Err(Error::new(
                "CONTEXT_TOO_LARGE",
                "展开内容超过 4 MiB，请选择更少的上下文行。原始 Diff 保持不变。",
                expanded.len(),
            ));
        }
        // Full-index headers bind the normalized old/new file bytes, not just
        // the displayed changed lines. Context may not come from another base.
        let header = |text: &str| {
            text.split_inclusive('\n')
                .take_while(|line| !line.starts_with("@@ "))
                .collect::<String>()
        };
        if header(&expanded) != header(&diff.patch) {
            return Err(Error::stale());
        }
        let expanded_hunks = patch::hunks(&expanded, "read-only-context");
        let lines: Vec<DiffLine> = expanded_hunks.into_iter().flat_map(|h| h.lines).collect();
        let mut cursor = 0;
        let mut gaps = Vec::new();
        for hunk in diff.hunks.iter().filter(|h| !h.lines.is_empty()) {
            // A wider Git hunk can merge several original units. Preserve each
            // original unit and attach only unchanged lines between those units.
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
        let context = DiffContext {
            snapshot_id: snapshot_id.into(),
            context_lines,
            gaps,
        };
        self.contexts.push_back(context.clone());
        while self.contexts.len() > 8
            || self.contexts.iter().map(context_size).sum::<usize>() > CONTEXT_CACHE_BYTES
        {
            self.contexts.pop_front();
        }
        Ok(context)
    }
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
fn context_size(context: &DiffContext) -> usize {
    context
        .gaps
        .iter()
        .flat_map(|gap| &gap.lines)
        .map(|line| line.content.len() + 128)
        .sum()
}
