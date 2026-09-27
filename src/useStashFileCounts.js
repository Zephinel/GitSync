import { useEffect, useMemo, useState } from 'react'
import {
  peekStashDetail,
  readStashDetail,
} from './stashDetailRepository.js'

export default function useStashFileCounts(repoPath, entries = []) {
  const signature = useMemo(
    () => entries.map((entry) => `${entry.id}:${entry.fileCount ?? ''}`).join('\0'),
    [entries]
  )
  const [counts, setCounts] = useState({})

  useEffect(() => {
    let active = true
    const visibleEntries = entries.filter((entry) => entry?.id)
    const initial = {}
    const pending = []

    for (const entry of visibleEntries) {
      if (Number.isFinite(entry.fileCount)) {
        initial[entry.id] = entry.fileCount
        continue
      }
      const detail = peekStashDetail(repoPath, entry.id)
      if (detail) initial[entry.id] = detail.fileCount
      else pending.push(entry)
    }
    setCounts(initial)

    let cursor = 0
    const worker = async () => {
      while (active && cursor < pending.length) {
        const entry = pending[cursor]
        cursor += 1
        try {
          const detail = await readStashDetail(repoPath, entry.id)
          if (!active) continue
          const value = detail.fileCount
          setCounts((current) => current[entry.id] === value
            ? current
            : { ...current, [entry.id]: value })
        } catch {
          // The shared repository applies a bounded cooldown and later views can retry.
        }
      }
    }

    const workers = Array.from({ length: Math.min(3, pending.length) }, () => worker())
    void Promise.all(workers)
    return () => { active = false }
  }, [repoPath, signature])

  return counts
}
