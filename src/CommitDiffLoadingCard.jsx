import { DiffIcon as CanonicalDiffIcon } from './icons/CanonicalIcons.jsx'

export function CodeBrandIcon() {
  return <CanonicalDiffIcon />
}

function CommitDiffSkeleton() {
  return (
    <div className="commit-diff-skeleton" aria-hidden="true">
      <span className="commit-diff-skeleton__line commit-diff-skeleton__line--wide" />
      <span className="commit-diff-skeleton__line" />
      <span className="commit-diff-skeleton__line commit-diff-skeleton__line--short" />
    </div>
  )
}

export function CommitDiffLoadingCard({ data, onClose }) {
  return (
    <>
      <button className="commit-diff-backdrop" type="button" onClick={onClose} aria-label="关闭提交 Diff" />
      <section className="commit-diff-stage commit-diff-stage--preloading" aria-label="提交 Diff 正在加载">
        <div className="commit-diff-preload-card">
          <div className="commit-diff-preload-card__icon"><CodeBrandIcon /></div>
          <div className="commit-diff-preload-card__copy">
            <div className="commit-diff-preload-card__title">正在准备 Diff 视图</div>
            <div className="commit-diff-preload-card__meta">{data?.repoName || 'GitSync'} · {data?.commit?.hash || '-'}</div>
          </div>
          <div className="commit-diff-preload-card__skeleton"><CommitDiffSkeleton /></div>
        </div>
      </section>
    </>
  )
}
