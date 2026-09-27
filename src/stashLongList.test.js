import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import {
  STASH_DETAIL_SEARCH_STATE,
  stashDetailSearchState,
  stashDetailSearchStateIsVisible,
} from './stashDetailSearch.js'

const read = (path) => readFileSync(new URL(path, import.meta.url), 'utf8')

test('backend returns every Stash while limiting only base-summary enrichment', () => {
  const types = read('../src-tauri/src/stash/mod.rs')
  const snapshot = read('../src-tauri/src/stash/snapshot.rs')
  const stream = read('../src-tauri/src/stash/snapshot_stream.rs')

  assert.match(types, /GIT_STASH_BASE_SUMMARY_LIMIT: usize = 100/)
  assert.match(snapshot, /summary_entries = all_stashes[\s\S]*take\(GIT_STASH_BASE_SUMMARY_LIMIT\)/)
  assert.match(snapshot, /let mut display_stashes = all_stashes\.clone\(\)/)
  assert.match(snapshot, /stashes_truncated: false/)
  assert.doesNotMatch(snapshot, /display_stashes\.truncate|display_stashes\s*=\s*all_stashes\s*\.into_iter\(\)\s*\.take/)
  assert.match(stream, /async fn read_snapshot_stash_list/)
  assert.match(stream, /entries\.push\(parse_stash_list_record\(&record\)\?\)/)
})

test('long-list rendering uses containment and a non-truncating search projection', () => {
  const legacyCss = read('./StashManagerLongList.css')
  const tableCss = read('./stash-manager/StashManagerTable.css')
  const finalCss = read('./StashFinalPolish.css')
  const styleAuthority = read('./StashStyleAuthority.css')
  const list = read('./stash-manager/StashManagerList.jsx')
  const main = read('./main.jsx')

  assert.match(legacyCss, /content-visibility: auto;/)
  assert.match(tableCss, /\.stash-manager-table-row \{[\s\S]*content-visibility: auto;/)
  assert.match(tableCss, /contain: layout paint style;/)
  assert.match(finalCss, /\.stash-manager-master-list__item \{[\s\S]*content-visibility: auto;/)
  assert.match(list, /const filteredStashes = useMemo/)
  assert.match(list, /snapshot\?\.stashes \|\| \[\]/)
  assert.match(list, /pagedStashes\.map/)
  assert.doesNotMatch(list, /slice\(0,\s*100\)|stashes\.slice\(0/)
  assert.match(main, /import '\.\/StashStyleAuthority\.css'/)
  assert.match(styleAuthority, /@import '\.\/StashManagerLongList\.css';/)
})

test('detail cache validity comes from authoritative snapshot membership, never branch/search filtering', () => {
  const list = read('./stash-manager/StashManagerList.jsx')
  const index = read('./stash-manager/useStashDetailIndex.js')

  assert.match(list, /stashSnapshotHasCompleteStashList\(snapshot\)/)
  assert.match(list, /useStashDetailIndex\([\s\S]*repoPath,[\s\S]*allStashes,[\s\S]*preliminary,[\s\S]*preliminaryVisible,[\s\S]*query,[\s\S]*canPruneAbsent:/)
  assert.match(index, /authorityEntries = \[\]/)
  assert.match(index, /searchEntries = \[\]/)
  assert.match(index, /const authorityIds = useMemo/)
  assert.match(index, /const searchScope = useMemo/)
  assert.match(index, /if \(!repoPath \|\| !canPruneAbsent\) return/)
  assert.match(index, /pruneStashDetails\(repoPath, authorityIds\)/)
  assert.doesNotMatch(index, /pruneStashDetails\(repoPath, search/)
})

test('bounded Detail search is tri-state so truncation or read failure cannot become a false negative', () => {
  const fullDetail = {
    filesTruncated: false,
    files: [{ path: 'src/visible.js', oldPath: null }],
  }
  const truncatedDetail = {
    filesTruncated: true,
    files: [{ path: 'src/visible.js', oldPath: null }],
  }

  assert.equal(stashDetailSearchState(fullDetail, 'visible'), STASH_DETAIL_SEARCH_STATE.MATCH)
  assert.equal(stashDetailSearchState(fullDetail, 'missing'), STASH_DETAIL_SEARCH_STATE.NO_MATCH)
  assert.equal(stashDetailSearchState(truncatedDetail, 'missing'), STASH_DETAIL_SEARCH_STATE.UNKNOWN)
  assert.equal(stashDetailSearchStateIsVisible(STASH_DETAIL_SEARCH_STATE.MATCH), true)
  assert.equal(stashDetailSearchStateIsVisible(STASH_DETAIL_SEARCH_STATE.UNKNOWN), true)
  assert.equal(stashDetailSearchStateIsVisible(STASH_DETAIL_SEARCH_STATE.NO_MATCH), false)

  const index = read('./stash-manager/useStashDetailIndex.js')
  const list = read('./stash-manager/StashManagerList.jsx')
  assert.match(index, /const searchUnknownRef = useRef\(new Set\(\)\)/)
  assert.match(index, /An unavailable detail cannot prove a filename does not match/)
  assert.match(index, /searchIncomplete:/)
  assert.match(list, /未加载部分无法排除的条目已保留在结果中/)
})

test('detail reads use one bounded generation-safe repository per identity', () => {
  const repository = read('./stashDetailRepository.js')
  const index = read('./stash-manager/useStashDetailIndex.js')
  const counts = read('./useStashFileCounts.js')

  assert.match(repository, /STASH_DETAIL_CACHE_LIMIT = 256/)
  assert.match(repository, /STASH_DETAIL_NATIVE_CONCURRENCY = 4/)
  assert.match(repository, /export class StashDetailSupersededError extends Error/)
  assert.match(repository, /export function createStashDetailRepository/)
  assert.match(repository, /const detailFlights = new Map\(\)/)
  assert.match(repository, /const nativeQueues = new Map\(\)/)
  assert.match(repository, /const active = detailFlights\.get\(key\)/)
  assert.match(repository, /if \(active && !force\) \{[\s\S]*active\.persistentConsumer = true[\s\S]*return active\.promise[\s\S]*return bindAbortableConsumer\(active, signal\)/)
  assert.match(repository, /if \(active && force\) invalidateFlight\(key, \{ detach: true \}\)/)
  assert.match(repository, /while \(detailCache\.size > cacheLimit\)/)
  assert.match(repository, /failureCooldownMs/)
  assert.match(repository, /const invalidatedFlightTokens = new Set\(\)/)
  assert.match(repository, /invalidatedFlightTokens\.has\(token\)/)
  assert.match(repository, /detailFlights\.get\(key\)\?\.token !== token/)
  assert.match(repository, /throw new StashDetailSupersededError/)
  assert.match(repository, /for \(const key of \[\.\.\.failureUntil\.keys\(\)\]\)/)
  assert.match(repository, /invalidatePrefix/)
  assert.match(repository, /pruneNativeQueue/)
  assert.match(index, /readStashDetail/)
  assert.match(index, /peekStashDetail/)
  assert.match(index, /pruneStashDetails/)
  assert.match(counts, /readStashDetail/)
  assert.match(counts, /peekStashDetail/)
  assert.doesNotMatch(`${index}\n${counts}`, /const detailCache = new Map|const fileCountCache = new Map|const failedKeys = new Set/)
})

test('long-list support has no interval polling or unbounded retry loops', () => {
  const sources = [
    read('./StashManagerLongList.css'),
    read('./stash-manager/StashManagerDialog.jsx'),
    read('./stash-manager/StashManagerList.jsx'),
    read('./stashDetailRepository.js'),
    read('../src-tauri/src/stash/snapshot.rs'),
  ].join('\n')

  assert.doesNotMatch(sources, /setInterval|requestIdleCallback|tokio::spawn|loop \{/)
})
