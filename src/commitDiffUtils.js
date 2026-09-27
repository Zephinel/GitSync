function tokenizeForInlineDiff(value) {
  return String(value || '').match(/\s+|[\p{L}\p{N}_$]+|[^\s\p{L}\p{N}_$]+/gu) || []
}

function isWhitespaceToken(token) {
  return /^\s+$/.test(token)
}

export function diffInlineTokens(oldText, newText) {
  const oldTokens = tokenizeForInlineDiff(oldText)
  const newTokens = tokenizeForInlineDiff(newText)
  const oldLength = oldTokens.length
  const newLength = newTokens.length

  if (oldLength === 0 && newLength === 0) return { oldTokens: [], newTokens: [] }
  if (oldLength * newLength > 40000) {
    return {
      oldTokens: oldTokens.map((text) => ({ text, type: isWhitespaceToken(text) ? 'same' : 'removed' })),
      newTokens: newTokens.map((text) => ({ text, type: isWhitespaceToken(text) ? 'same' : 'added' })),
    }
  }

  const dp = Array.from({ length: oldLength + 1 }, () => Array(newLength + 1).fill(0))
  for (let oldIndex = oldLength - 1; oldIndex >= 0; oldIndex -= 1) {
    for (let newIndex = newLength - 1; newIndex >= 0; newIndex -= 1) {
      dp[oldIndex][newIndex] = oldTokens[oldIndex] === newTokens[newIndex]
        ? dp[oldIndex + 1][newIndex + 1] + 1
        : Math.max(dp[oldIndex + 1][newIndex], dp[oldIndex][newIndex + 1])
    }
  }

  const matchedOld = new Set()
  const matchedNew = new Set()
  let oldIndex = 0
  let newIndex = 0
  while (oldIndex < oldLength && newIndex < newLength) {
    if (oldTokens[oldIndex] === newTokens[newIndex]) {
      matchedOld.add(oldIndex)
      matchedNew.add(newIndex)
      oldIndex += 1
      newIndex += 1
    } else if (dp[oldIndex + 1][newIndex] >= dp[oldIndex][newIndex + 1]) {
      oldIndex += 1
    } else {
      newIndex += 1
    }
  }

  return {
    oldTokens: oldTokens.map((text, index) => ({
      text,
      type: matchedOld.has(index) || isWhitespaceToken(text) ? 'same' : 'removed',
    })),
    newTokens: newTokens.map((text, index) => ({
      text,
      type: matchedNew.has(index) || isWhitespaceToken(text) ? 'same' : 'added',
    })),
  }
}

export function parsePatchRows(patch) {
  const lines = String(patch || '').replace(/\r\n/g, '\n').split('\n')
  const rows = []
  let oldLine = 0
  let newLine = 0
  let seenHunk = false

  lines.forEach((line, index) => {
    const hunkMatch = line.match(/^@@\s+-(\d+)(?:,\d+)?\s+\+(\d+)(?:,\d+)?\s+@@/)
    if (hunkMatch) {
      seenHunk = true
      oldLine = Number(hunkMatch[1]) || 0
      newLine = Number(hunkMatch[2]) || 0
      rows.push({ key: `hunk-${index}`, type: 'hunk', oldNumber: '', newNumber: '', text: line })
      return
    }
    if (!seenHunk) return
    if (!line && index === lines.length - 1) return
    const prefix = line[0] || ' '
    if (prefix === '+') return rows.push({ key: `add-${index}`, type: 'add', oldNumber: '', newNumber: String(newLine++), text: line })
    if (prefix === '-') return rows.push({ key: `del-${index}`, type: 'del', oldNumber: String(oldLine++), newNumber: '', text: line })
    if (line.startsWith('\\ No newline')) return rows.push({ key: `note-${index}`, type: 'note', oldNumber: '', newNumber: '', text: line })
    rows.push({ key: `ctx-${index}`, type: 'context', oldNumber: String(oldLine++), newNumber: String(newLine++), text: line })
  })

  return rows
}

export function parseSplitPatchRows(patch) {
  const lines = String(patch || '').replace(/\r\n/g, '\n').split('\n')
  const rows = []
  let oldLine = 0
  let newLine = 0
  let seenHunk = false
  let pendingDeletes = []
  let pendingAdds = []

  const flushChangeGroup = () => {
    const maxLength = Math.max(pendingDeletes.length, pendingAdds.length)
    for (let index = 0; index < maxLength; index += 1) {
      const deleted = pendingDeletes[index] || null
      const added = pendingAdds[index] || null
      const inline = deleted && added ? diffInlineTokens(deleted.text, added.text) : { oldTokens: null, newTokens: null }
      rows.push({
        key: `change-${rows.length}`,
        type: deleted && added ? 'pair' : (deleted ? 'del' : 'add'),
        oldNumber: deleted?.number || '',
        newNumber: added?.number || '',
        oldText: deleted?.text || '',
        newText: added?.text || '',
        oldType: deleted ? 'del' : 'blank',
        newType: added ? 'add' : 'blank',
        oldTokens: inline.oldTokens,
        newTokens: inline.newTokens,
      })
    }
    pendingDeletes = []
    pendingAdds = []
  }

  lines.forEach((line, index) => {
    const hunkMatch = line.match(/^@@\s+-(\d+)(?:,\d+)?\s+\+(\d+)(?:,\d+)?\s+@@/)
    if (hunkMatch) {
      flushChangeGroup()
      seenHunk = true
      oldLine = Number(hunkMatch[1]) || 0
      newLine = Number(hunkMatch[2]) || 0
      rows.push({ key: `hunk-${index}`, type: 'hunk', oldNumber: '', newNumber: '', oldText: line, newText: line })
      return
    }

    if (!seenHunk) return
    if (!line && index === lines.length - 1) return

    if (line.startsWith('\\ No newline')) {
      flushChangeGroup()
      rows.push({ key: `note-${index}`, type: 'note', oldNumber: '', newNumber: '', oldText: line, newText: line })
      return
    }

    const prefix = line[0] || ' '
    const text = line.length > 0 ? line.slice(1) : ''
    if (prefix === '-') {
      pendingDeletes.push({ number: String(oldLine++), text })
      return
    }
    if (prefix === '+') {
      pendingAdds.push({ number: String(newLine++), text })
      return
    }

    flushChangeGroup()
    rows.push({
      key: `ctx-${index}`,
      type: 'context',
      oldNumber: String(oldLine++),
      newNumber: String(newLine++),
      oldText: text,
      newText: text,
      oldType: 'context',
      newType: 'context',
    })
  })

  flushChangeGroup()
  return rows
}

export function buildBinaryFileDiff(file, { commitHash = '', fullHash = '' } = {}) {
  const resolvedFullHash = String(fullHash || commitHash || '')
  return {
    hash: resolvedFullHash ? resolvedFullHash.slice(0, 7) : String(commitHash || ''),
    full_hash: resolvedFullHash,
    path: file.path,
    old_path: file.old_path || null,
    status: file.status,
    additions: file.additions,
    deletions: file.deletions,
    is_binary: true,
    is_too_large: false,
    truncated: false,
    patch: '',
  }
}
