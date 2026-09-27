function setControlledInputValue(input, value) {
  if (!(input instanceof HTMLInputElement)) return
  const descriptor = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')
  descriptor?.set?.call(input, value)
  input.dispatchEvent(new Event('input', { bubbles: true }))
  input.dispatchEvent(new Event('change', { bubbles: true }))
}

function parseFindingLocation(value) {
  const text = String(value || '').trim()
  if (!text || text === '跨文件') return null
  const lineMatch = text.match(/^(.*):(\d+)(?:[–-](\d+))?$/)
  if (lineMatch?.[1]) {
    return {
      path: lineMatch[1],
      line: Number(lineMatch[2]),
    }
  }
  return { path: text, line: null }
}

function findFilePreview(path) {
  const row = Array.from(document.querySelectorAll('.working-changes-file-row')).find((candidate) => (
    candidate.getAttribute('data-file-path') === path
  ))
  const preview = row?.querySelector('.working-changes-file-cell__preview')
  return preview instanceof HTMLButtonElement ? preview : null
}

function captureCheckboxState(preview) {
  const checkbox = preview
    ?.closest?.('.working-changes-file-row')
    ?.querySelector?.('.working-changes-checkbox input[type="checkbox"]')
  if (!(checkbox instanceof HTMLInputElement)) return null
  return { checkbox, checked: checkbox.checked }
}

function restoreCheckboxState(snapshot) {
  if (!snapshot) return
  const restore = () => {
    const { checkbox, checked } = snapshot
    if (!(checkbox instanceof HTMLInputElement) || !checkbox.isConnected || checkbox.disabled) return
    if (checkbox.checked !== checked) checkbox.click()
  }
  if (typeof window.requestAnimationFrame === 'function') window.requestAnimationFrame(restore)
  else window.setTimeout(restore, 0)
}

function scrollToLine(line) {
  if (!line) return false
  const number = String(line)
  const target = Array.from(document.querySelectorAll(
    '.commit-diff-raw__num--new, .commit-diff-split__num--new'
  )).find((node) => node.textContent?.trim() === number)
  const row = target?.closest?.('.commit-diff-raw__line, .commit-diff-split__row')
  if (!row) return false
  row.scrollIntoView({ block: 'center', behavior: 'smooth' })
  row.classList.add('ai-review-line-target')
  window.setTimeout(() => row.classList.remove('ai-review-line-target'), 1400)
  return true
}

function navigate(location, attempt = 0) {
  let preview = findFilePreview(location.path)
  if (!preview && attempt === 0) {
    const search = document.querySelector('.working-changes-sheet .commit-diff-sidebar__search')
    if (search instanceof HTMLInputElement && search.value) setControlledInputValue(search, '')
  }
  preview = preview || findFilePreview(location.path)
  if (!preview) {
    if (attempt < 5) window.setTimeout(() => navigate(location, attempt + 1), 80 + attempt * 80)
    return
  }
  if (attempt === 0 || preview.getAttribute('aria-pressed') !== 'true') {
    const checkboxSnapshot = captureCheckboxState(preview)
    preview.dataset.aiReviewNavigation = 'true'
    preview.click()
    restoreCheckboxState(checkboxSnapshot)
    window.setTimeout(() => { delete preview.dataset.aiReviewNavigation }, 80)
  }
  if (!scrollToLine(location.line) && attempt < 8) {
    window.setTimeout(() => navigate(location, attempt + 1), 120 + attempt * 100)
  }
}

function navigateReviewFinding(finding) {
  const path = String(finding?.file || '').trim()
  if (!path) return
  navigate({ path, line: Number(finding?.startLine) || null })
}

export { navigateReviewFinding, parseFindingLocation }
