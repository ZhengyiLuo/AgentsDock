import { useLocale } from './i18n'

const en = {
  changes: 'Changes', region: 'Workspace changes', refresh: 'Refresh changes', loading: 'Loading changes…',
  branch: 'Branch', detached: 'Detached HEAD', all: 'All changes', staged: 'Staged', unstaged: 'Unstaged',
  untracked: 'Untracked', conflicts: 'Conflicts', filter: 'Filter changed files', noMatches: 'No matching files',
  clean: 'Working tree clean', select: 'Select a file to review its changes.', empty: 'There are no changes to review.',
  stage: 'Stage', unstage: 'Unstage', stageAll: 'Stage all', unstageAll: 'Unstage all',
  review: 'Review commit', reviewTitle: 'Review staged changes', commit: 'Commit staged changes',
  message: 'Commit message', messageHint: 'Summarize this change', cancel: 'Cancel', close: 'Close',
  commitHint: 'Only staged changes will be committed. Select each file to inspect its staged diff.',
  committed: 'Changes committed.', resolved: 'Resolution saved and staged.', completed: 'Operation completed.', moreConflicts: 'More conflicts to resolve.', inProgress: 'Operation still in progress.',
  current: 'Current (ours)', incoming: 'Incoming (theirs)', base: 'Base', result: 'Resolved result',
  useCurrent: 'Use current', useIncoming: 'Use incoming', saveResolution: 'Save resolution',
  conflictHint: 'Edit the result, remove conflict markers, then save the resolution to stage this file.',
  rebaseHint: 'During a rebase, current is the branch being rebased onto; incoming is the commit being replayed.',
  missing: 'This side does not contain the file.', binary: 'Binary content cannot be previewed here.',
  binaryConflict: 'Resolve this binary conflict in your Git tools, then refresh Changes.',
  truncated: 'Preview truncated. Review the complete file before committing.', noDiff: 'No text diff to display.',
  continue: 'Continue', abort: 'Abort', abortTitle: 'Abort the operation?',
  abortHint: 'Git will attempt to restore the state from before this operation. Work made during the operation may be lost.',
  abortConfirm: 'Abort operation', abortDone: 'Operation aborted.', discardTitle: 'Discard this resolution draft?',
  discardHint: 'Your edits to the resolved result have not been saved.', discard: 'Discard draft',
  dirty: 'Unsaved resolution', stale: 'The repository changed. Reload this conflict before saving; your draft has been preserved.',
  reload: 'Reload conflict', reviewChanged: 'Staged changes have changed. Review the updated files before committing.',
  update: 'Update AgentsServer to use workspace Changes.', unavailable: 'Changes are unavailable.', noRepository: 'This workspace is not inside a Git repository.',
  readOnly: 'This chat is read-only.', markers: 'Remove all conflict markers before saving.',
  changed: 'changed files', changedOne: 'changed file', stagedFiles: 'staged files', stagedFile: 'staged file', conflict: 'conflict', operation: 'in progress',
  merge: 'Merge', rebase: 'Rebase', 'cherry-pick': 'Cherry-pick', revert: 'Revert'
}

const zh: typeof en = {
  changes: '更改', region: '工作区更改', refresh: '刷新更改', loading: '正在加载更改…',
  branch: '分支', detached: '分离的 HEAD', all: '全部更改', staged: '已暂存', unstaged: '未暂存',
  untracked: '未跟踪', conflicts: '冲突', filter: '筛选已更改文件', noMatches: '没有匹配的文件',
  clean: '工作区干净', select: '选择文件以查看更改。', empty: '没有可查看的更改。',
  stage: '暂存', unstage: '取消暂存', stageAll: '全部暂存', unstageAll: '全部取消暂存',
  review: '查看并提交', reviewTitle: '检查已暂存更改', commit: '提交已暂存更改',
  message: '提交说明', messageHint: '概述此更改', cancel: '取消', close: '关闭',
  commitHint: '只会提交已暂存的更改。选择每个文件以检查其暂存差异。',
  committed: '更改已提交。', resolved: '解决结果已保存并暂存。', completed: '操作已完成。', moreConflicts: '还有更多冲突需要解决。', inProgress: '操作仍在进行中。',
  current: '当前版本（ours）', incoming: '传入版本（theirs）', base: '基础版本', result: '解决结果',
  useCurrent: '使用当前版本', useIncoming: '使用传入版本', saveResolution: '保存解决结果',
  conflictHint: '编辑结果并移除冲突标记，然后保存以暂存此文件。',
  rebaseHint: '变基时，当前版本是变基目标分支；传入版本是正在重放的提交。',
  missing: '此版本不包含该文件。', binary: '无法在此预览二进制内容。',
  binaryConflict: '请在 Git 工具中解决此二进制冲突，然后刷新更改。',
  truncated: '预览已截断。提交前请检查完整文件。', noDiff: '没有可显示的文本差异。',
  continue: '继续', abort: '中止', abortTitle: '中止此操作？',
  abortHint: 'Git 将尝试恢复操作之前的状态。在此操作期间的工作可能会丢失。',
  abortConfirm: '中止操作', abortDone: '操作已中止。', discardTitle: '放弃此冲突解决草稿？',
  discardHint: '您对解决结果的编辑尚未保存。', discard: '放弃草稿',
  dirty: '未保存的解决结果', stale: '仓库已更改。请在保存前重新加载冲突；您的草稿已保留。',
  reload: '重新加载冲突', reviewChanged: '暂存的更改已更新。提交前请重新检查文件。',
  update: '请更新 AgentsServer 以使用工作区更改。', unavailable: '更改暂不可用。', noRepository: '此工作区不在 Git 仓库中。',
  readOnly: '此聊天为只读。', markers: '请在保存前移除所有冲突标记。',
  changed: '个更改文件', changedOne: '个更改文件', stagedFiles: '个已暂存文件', stagedFile: '个已暂存文件', conflict: '个冲突', operation: '进行中',
  merge: '合并', rebase: '变基', 'cherry-pick': '拣选', revert: '还原'
}

export function useWorkspaceGitLabels(): typeof en {
  return useLocale() === 'zh-CN' ? zh : en
}
