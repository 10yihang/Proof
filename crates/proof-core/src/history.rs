use crate::{git, guarded_file::BoundFile, model::*, Error, Proof, Result};
use std::path::Path;

const BLAME_PAGE: usize = 400;

impl Proof {
    pub fn file_blame(
        &self,
        workspace_id: &str,
        path: &str,
        revision: Option<&str>,
        offset: usize,
    ) -> Result<FileBlame> {
        let workspace = self.store.workspace(workspace_id)?;
        git::checked_path(&workspace, path)?;
        let git = self.git()?;
        let guard = if revision.is_none() {
            Some(git.guard(&workspace, path, None)?)
        } else {
            None
        };
        let head = git.head(&workspace)?;
        let revision = revision
            .map(|oid| crate::text_files::verified_commit(&git, &workspace, oid))
            .transpose()?;
        let bytes = if let Some(revision) = &revision {
            git.query(
                &workspace,
                &["cat-file", "blob", &format!("{revision}:{path}")],
            )?
        } else {
            BoundFile::open(Path::new(&workspace.path), path)?
                .read()?
                .ok_or_else(|| {
                    Error::new("FILE_MISSING", "当前文件不存在，可选择历史提交查看。", path)
                })?
                .bytes
        };
        if bytes.contains(&0) {
            return Err(Error::new(
                "BINARY_BLAME",
                "二进制文件不提供逐行 Blame。",
                path,
            ));
        }
        let content = git::text(bytes)?;
        let total_lines = content.split_inclusive('\n').count();
        let offset = offset.min(total_lines);
        let end = (offset + BLAME_PAGE).min(total_lines);
        let tracked = !git
            .query(&workspace, &["ls-files", "-z", "--", path])?
            .is_empty();
        let lines = if end == offset {
            Vec::new()
        } else if revision.is_none() && (!tracked || head.is_none()) {
            content
                .split_inclusive('\n')
                .skip(offset)
                .take(end - offset)
                .enumerate()
                .map(|(i, line)| BlameLine {
                    oid: None,
                    original_line: (offset + i + 1) as u32,
                    line: (offset + i + 1) as u32,
                    author: None,
                    author_time: None,
                    summary: "未提交变化".into(),
                    content: line.strip_suffix('\n').unwrap_or(line).into(),
                    origin_path: path.into(),
                    uncommitted: true,
                })
                .collect()
        } else {
            let range = format!("{},{}", offset + 1, end);
            let mut args = vec!["blame", "--line-porcelain", "--no-textconv", "-L", &range];
            if let Some(revision) = &revision {
                args.push(revision);
            }
            args.extend(["--", path]);
            parse_blame(&git::text(git.query(&workspace, &args)?)?)?
        };
        if let Some(guard) = guard {
            if git.guard(&workspace, path, None)? != guard {
                return Err(Error::stale());
            }
        }
        if lines.len() != end - offset {
            return Err(Error::new(
                "BLAME_INCOMPLETE",
                "Git 返回的 Blame 行数不完整，请重新加载。",
                format!("Expected {}, received {}", end - offset, lines.len()),
            ));
        }
        if revision.is_none() {
            let raw: Vec<&str> = content
                .split_inclusive('\n')
                .skip(offset)
                .take(end - offset)
                .collect();
            for (index, line) in lines.iter().enumerate() {
                let original = raw[index].strip_suffix('\n').unwrap_or(raw[index]);
                if line.line as usize != offset + index + 1
                    || line.content.trim_end_matches('\r') != original.trim_end_matches('\r')
                {
                    return Err(Error::new(
                        "BLAME_TRANSFORM",
                        "Git 过滤后的内容与当前工作树不能逐行对应，请选择已提交版本查看 Blame。",
                        "Configured content transform changed the displayed lines",
                    ));
                }
            }
        }
        Ok(FileBlame { workspace_id: workspace_id.into(), path: path.into(), revision, head, lines, total_lines, offset, has_more: end < total_lines,
            notice: "作者来自 Git 历史；未提交行不指定作者。Git 的重命名追溯有局限，无法定位旧路径时请填写当时的文件路径。".into() })
    }
}

fn parse_blame(text: &str) -> Result<Vec<BlameLine>> {
    let mut rows = Vec::new();
    let mut current: Option<BlameLine> = None;
    for line in text.split('\n') {
        if let Some(content) = line.strip_prefix('\t') {
            let mut row = current.take().ok_or_else(parse_error)?;
            row.content = content.into();
            if row.uncommitted {
                row.author = None;
                row.author_time = None;
                row.summary = "未提交变化".into();
            }
            rows.push(row);
        } else if let Some(row) = &mut current {
            if let Some(author) = line.strip_prefix("author ") {
                row.author = Some(author.into());
            } else if let Some(time) = line.strip_prefix("author-time ") {
                row.author_time = Some(time.parse().map_err(|_| parse_error())?);
            } else if let Some(summary) = line.strip_prefix("summary ") {
                row.summary = summary.into();
            } else if let Some(path) = line.strip_prefix("filename ") {
                row.origin_path = decode_path(path)?;
            }
        } else if !line.is_empty() {
            let fields: Vec<&str> = line.split_whitespace().collect();
            if !(3..=4).contains(&fields.len())
                || ![40, 64].contains(&fields[0].len())
                || !fields[0].bytes().all(|c| c.is_ascii_hexdigit())
            {
                return Err(parse_error());
            }
            let uncommitted = fields[0].bytes().all(|c| c == b'0');
            current = Some(BlameLine {
                oid: (!uncommitted).then(|| fields[0].into()),
                original_line: fields[1].parse().map_err(|_| parse_error())?,
                line: fields[2].parse().map_err(|_| parse_error())?,
                author: None,
                author_time: None,
                summary: String::new(),
                content: String::new(),
                origin_path: String::new(),
                uncommitted,
            });
        }
    }
    if current.is_some() {
        return Err(parse_error());
    }
    Ok(rows)
}
fn parse_error() -> Error {
    Error::new(
        "BLAME_PARSE",
        "Git 的 Blame 输出无法完整解析。",
        "Invalid line porcelain record",
    )
}
fn decode_path(path: &str) -> Result<String> {
    let Some(quoted) = path.strip_prefix('"').and_then(|p| p.strip_suffix('"')) else {
        return Ok(path.into());
    };
    let mut out = Vec::new();
    let mut bytes = quoted.bytes();
    while let Some(byte) = bytes.next() {
        if byte != b'\\' {
            out.push(byte);
            continue;
        }
        let escaped = bytes.next().ok_or_else(parse_error)?;
        out.push(match escaped {
            b'n' => b'\n',
            b't' => b'\t',
            b'r' => b'\r',
            b'b' => 8,
            b'f' => 12,
            b'v' => 11,
            b'a' => 7,
            b'\\' => b'\\',
            b'"' => b'"',
            b'0'..=b'3' => {
                let b = bytes.next().ok_or_else(parse_error)?;
                let c = bytes.next().ok_or_else(parse_error)?;
                if !(b'0'..=b'7').contains(&b) || !(b'0'..=b'7').contains(&c) {
                    return Err(parse_error());
                }
                (escaped - b'0') * 64 + (b - b'0') * 8 + (c - b'0')
            }
            _ => return Err(parse_error()),
        });
    }
    git::text(out)
}
