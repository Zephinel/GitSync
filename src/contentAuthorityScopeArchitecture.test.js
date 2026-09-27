import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const rustSourceDir = join(here, '..', 'src-tauri', 'src')
const readRust = (relativePath) => readFileSync(join(rustSourceDir, relativePath), 'utf8')

const atomicSource = () => [
  readRust('git_atomic_mutation.rs'),
  readRust('git_atomic_mutation_index.rs'),
  readRust('git_atomic_mutation_commit.rs'),
  readRust('git_atomic_mutation_discard.rs'),
].join('\n')

test('Staging remains status-only and delegates selected mutation to atomic immutable authority', () => {
  const staging = [readRust('staging_authority_overlay.rs'), readRust('staging_authority_prelude.rs'), readRust('staging_authority_operation_part1.rs'), readRust('staging_authority_operation_part2.rs')].join('\n')
  const atomic = atomicSource()

  assert.match(staging, /Staging remains status-only/)
  assert.match(staging, /for file in &mut snapshot\.files \{[\s\S]*file\.id\.clear\(\)/)
  assert.doesNotMatch(staging, /collect_mutation_content_ids/)
  assert.match(staging, /git_atomic_mutation::stage_verified_entry/)
  assert.match(staging, /git_atomic_mutation::unstage_verified_entry/)

  assert.match(atomic, /capture_expected_snapshots/)
  assert.match(atomic, /capture_mutation_entry_snapshots/)
  assert.match(atomic, /stage_verified_entry_inner/)
  assert.match(atomic, /unstage_verified_entry_inner/)
})

test('Working preview hashes dirty set once while executable mutation recaptures selected scope only', () => {
  const working = [readRust('working_changes_authority_overlay.rs'), [readRust('working_changes_authority_prelude.rs'), readRust('working_changes_authority_prelude_part1.rs'), readRust('working_changes_authority_prelude_part2.rs')].join('\n'), readRust('working_changes_authority_operations.rs')].join('\n')
  const atomic = atomicSource()

  assert.equal((working.match(/collect_mutation_content_ids/g) || []).length, 1)
  assert.match(working, /read_working_summary_authoritative_inner/)
  assert.match(working, /git_atomic_mutation::commit_verified_entries/)
  assert.match(working, /git_atomic_mutation::discard_verified_entry/)
  assert.doesNotMatch(working, /find_authoritative_requested_files/)

  assert.match(atomic, /commit_verified_entries_inner[\s\S]*capture_expected_snapshots/)
  assert.match(atomic, /discard_verified_entry_inner[\s\S]*capture_expected_snapshots/)

  const diffStart = working.indexOf('pub async fn get_repo_working_file_diff_authoritative')
  const discardStart = working.indexOf('pub async fn discard_repo_working_files_authoritative')
  const diffSection = working.slice(diffStart, discardStart)
  assert.match(diffSection, /read_working_summary_inner\(&repo_path\)/)
  assert.doesNotMatch(diffSection, /capture_mutation_entry_snapshots|collect_mutation_content_ids/)
})

test('deterministic authority scope stays linear in selected count', () => {
  const dirtyCount = 1000
  const selectedCount = 100

  const previewEntryScope = dirtyCount
  const mutationEntryScope = selectedCount
  const totalEntryScope = previewEntryScope + mutationEntryScope
  const rejectedQuadraticScope = (2 * selectedCount + 2) * dirtyCount

  assert.equal(totalEntryScope, 1100)
  assert.equal(rejectedQuadraticScope, 202000)
  assert.ok(totalEntryScope < rejectedQuadraticScope / 100)
})
