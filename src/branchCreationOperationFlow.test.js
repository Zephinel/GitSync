import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const source = readFileSync(new URL('./BranchCreationDialog.jsx', import.meta.url), 'utf8')

test('repository mutations and result commands use synchronous single-flight guards', () => {
  assert.match(source, /const operationFlightRef = useRef\(false\)/)
  assert.match(source, /if \(!canConfirm \|\| !inspection \|\| !selectedSource \|\| operationFlightRef\.current\) return/)
  assert.match(source, /operationFlightRef\.current = true[\s\S]*const requestId = createBranchCreationRequestId\(\)/)
  assert.match(source, /if \(!operation\?\.requestId \|\| operationFlightRef\.current\) return/)
  assert.match(source, /finally \{[\s\S]*operationRequestIdRef\.current = ''[\s\S]*operationFlightRef\.current = false[\s\S]*setOperationBusy\(false\)/)
})

test('a lost execute response is reconciled with the exact original request id', () => {
  assert.match(source, /catch \(error\) \{[\s\S]*recoverAfterExecuteError\(\{[\s\S]*requestId,[\s\S]*executeError:/)
  assert.match(source, /invoke\('reconcile_repo_branch_creation', \{ path: repoPath, requestId \}\)/)
  assert.match(source, /NO_OPERATION_RECORD_MESSAGE/)
  assert.match(source, /await loadInspection\(\{ resetDraft: false \}\)/)
  assert.match(source, /buildUnknownTransportOperation\(\{[\s\S]*requestId,/)
  assert.match(source, /必须继续使用原请求 ID 刷新真实状态/)
  assert.match(source, /不会使用新的请求 ID重复创建/)
})

test('AI suggestion submission is guarded synchronously and local cancellation stops post-response validation too', () => {
  assert.match(source, /const aiFlightRef = useRef\(false\)/)
  assert.match(source, /if \(aiFlightRef\.current \|\| !inspection \|\| !selectedSource\) return/)
  assert.match(source, /aiFlightRef\.current = true[\s\S]*createBranchCreationRequestId\('branch-name'\)/)
  assert.match(source, /const stopAiRequestLocally = useCallback/)
  assert.match(source, /activeAiRequestIdRef\.current = ''/)
  assert.match(source, /aiRevisionRef\.current = ''/)
  assert.match(source, /aiFlightRef\.current = false/)
  assert.match(source, /setAiBusy\(false\)/)
  assert.match(source, /cancel_ai_branch_name_request/)
  assert.match(source, /stopAiRequestLocally\('AI 请求已取消；手动创建仍可继续'\)/)
  assert.match(source, /来源正在重新确认，旧 AI 请求已取消/)
})

test('dialog owns focus, traps Escape, and restores terminal progress from the actual operation result', () => {
  assert.match(source, /dialogRef\.current\?\.focus\?\.\(\{ preventScroll: true \}\)/)
  assert.match(source, /tabIndex=\{-1\}/)
  assert.match(source, /if \(event\.key === 'Escape'\) \{[\s\S]*event\.stopPropagation\(\)[\s\S]*stopImmediatePropagation/)
  assert.match(source, /function operationTerminalPhase\(operation\)/)
  assert.match(source, /setOperationPhase\(operationTerminalPhase\(next\)\)/)
  assert.match(source, /状态确认未完成；原结果仍然保留/)
})
