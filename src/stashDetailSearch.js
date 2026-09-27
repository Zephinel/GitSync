export const STASH_DETAIL_SEARCH_STATE = Object.freeze({
  MATCH: 'match',
  NO_MATCH: 'no_match',
  UNKNOWN: 'unknown',
})

function normalizedNeedle(value) {
  return String(value || '').trim().toLowerCase()
}

export function stashDetailSearchState(detail, query) {
  const needle = normalizedNeedle(query)
  if (!needle) return STASH_DETAIL_SEARCH_STATE.MATCH

  const files = Array.isArray(detail?.files) ? detail.files : []
  const matched = files.some((file) => [file?.path, file?.oldPath]
    .some((value) => String(value || '').toLowerCase().includes(needle)))
  if (matched) return STASH_DETAIL_SEARCH_STATE.MATCH

  return detail?.filesTruncated
    ? STASH_DETAIL_SEARCH_STATE.UNKNOWN
    : STASH_DETAIL_SEARCH_STATE.NO_MATCH
}

export function stashDetailSearchStateIsVisible(state) {
  return state !== STASH_DETAIL_SEARCH_STATE.NO_MATCH
}
