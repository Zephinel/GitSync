#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MutationIndexEntry {
    pub mode: String,
    pub oid: String,
    pub stage: u8,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum MutationWorktreeState {
    Missing,
    File {
        authority_mode: String,
        git_mode: String,
        raw_oid: String,
        staged_oid: String,
    },
    Symlink {
        authority_mode: String,
        raw_oid: String,
    },
    Gitlink {
        authority_mode: String,
        oid: String,
    },
    Directory {
        authority_mode: String,
    },
    Special {
        authority_mode: String,
        len: u64,
    },
}

impl MutationWorktreeState {
    pub fn index_entry(&self) -> Result<Option<MutationIndexEntry>, String> {
        match self {
            Self::Missing => Ok(None),
            Self::File {
                git_mode,
                staged_oid,
                ..
            } => Ok(Some(MutationIndexEntry {
                mode: git_mode.clone(),
                oid: staged_oid.clone(),
                stage: 0,
            })),
            Self::Symlink { raw_oid, .. } => Ok(Some(MutationIndexEntry {
                mode: "120000".to_string(),
                oid: raw_oid.clone(),
                stage: 0,
            })),
            Self::Gitlink { oid, .. } => Ok(Some(MutationIndexEntry {
                mode: "160000".to_string(),
                oid: oid.clone(),
                stage: 0,
            })),
            Self::Directory { .. } => Err(
                "普通目录不能作为单一 immutable Git mutation 输入；请刷新后分文件操作。"
                    .to_string(),
            ),
            Self::Special { .. } => Err(
                "特殊文件不能作为 immutable Git mutation 输入；本次操作已安全中止。"
                    .to_string(),
            ),
        }
    }

    pub fn is_claimable_discard_preimage(&self) -> bool {
        matches!(self, Self::File { .. } | Self::Symlink { .. })
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MutationPathSnapshot {
    pub path: String,
    pub index_entries: Vec<MutationIndexEntry>,
    pub index_id: String,
    pub worktree_id: String,
    pub worktree: MutationWorktreeState,
}

impl MutationPathSnapshot {
    pub fn stage0_index_entry(&self) -> Result<Option<MutationIndexEntry>, String> {
        if self.index_entries.is_empty() {
            return Ok(None);
        }
        if self.index_entries.len() != 1 || self.index_entries[0].stage != 0 {
            return Err(format!(
                "路径存在非 stage-0 index 状态，immutable mutation 不会猜测目标: {}",
                self.path
            ));
        }
        Ok(Some(self.index_entries[0].clone()))
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MutationEntrySnapshot {
    pub path: String,
    pub old_path: Option<String>,
    pub authority_id: String,
    pub current: MutationPathSnapshot,
    pub old: Option<MutationPathSnapshot>,
}

fn parse_git_oid(value: &str, context: &str) -> Result<String, String> {
    let value = value.trim().to_ascii_lowercase();
    if !matches!(value.len(), 40 | 64) || !value.chars().all(|character| character.is_ascii_hexdigit()) {
        return Err(format!("{} 返回了无效 Git object id: {}", context, value));
    }
    Ok(value)
}

fn parse_index_metadata(metadata: &str, path: &str) -> Result<MutationIndexEntry, String> {
    let mut fields = metadata.split_whitespace();
    let mode = fields
        .next()
        .ok_or_else(|| format!("Git index authority 缺少 mode: {}", path))?;
    let oid = fields
        .next()
        .ok_or_else(|| format!("Git index authority 缺少 object id: {}", path))?;
    let stage = fields
        .next()
        .ok_or_else(|| format!("Git index authority 缺少 stage: {}", path))?
        .parse::<u8>()
        .map_err(|_| format!("Git index authority stage 无效: {}", path))?;
    Ok(MutationIndexEntry {
        mode: mode.to_string(),
        oid: parse_git_oid(oid, "Git index authority")?,
        stage,
    })
}
