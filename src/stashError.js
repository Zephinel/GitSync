export const STASH_AUTHORITY_ADMISSION_TIMEOUT_CODE = '[STASH_AUTHORITY_ADMISSION_TIMEOUT]'

function rawStashErrorMessage(error) {
  if (typeof error === 'string') return error
  if (error?.message) return String(error.message)
  if (error?.title) return String(error.title)
  try { return JSON.stringify(error) } catch { return '未知错误' }
}

export function isStashAuthorityAdmissionTimeout(error) {
  return rawStashErrorMessage(error)
    .trimStart()
    .startsWith(STASH_AUTHORITY_ADMISSION_TIMEOUT_CODE)
}

export function stashErrorMessage(error) {
  const message = rawStashErrorMessage(error).trim()
  return message.startsWith(STASH_AUTHORITY_ADMISSION_TIMEOUT_CODE)
    ? message.slice(STASH_AUTHORITY_ADMISSION_TIMEOUT_CODE.length).trim()
    : message
}
