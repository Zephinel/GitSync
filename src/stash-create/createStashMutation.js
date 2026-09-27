import { invokeStashMutation, stashErrorMessage } from '../stashOperationClient.js'
import {
  buildCreateStashRequest,
  createStashRequestId,
} from '../stashViewModel.js'

export const messageOf = stashErrorMessage

export async function runCreateStashMutation({
  repoPath,
  snapshot,
  selectedScope,
  message,
  includeUntracked,
  keepIndex,
  files,
}) {
  const operation = selectedScope ? 'create_selected' : 'create'
  const requestId = createStashRequestId(selectedScope ? 'stash-selected' : 'stash-all')
  const request = buildCreateStashRequest(snapshot, {
    requestId,
    message,
    includeUntracked,
    keepIndex,
    files,
  })
  const command = selectedScope
    ? 'create_repo_stash_selected_authoritative'
    : 'create_repo_stash'

  return invokeStashMutation({
    repoPath,
    operation,
    command,
    request,
    requestId,
  })
}
