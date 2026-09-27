import { StrictMode, Suspense, lazy } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import AppBootstrapBoundary from './AppBootstrapBoundary.jsx'
import AppTooltipLayer from './AppTooltip.jsx'
import CommitDiffLayer from './CommitDiffLayer.jsx'
import './BranchManagementSyncFeedback.css'
import './BranchSwitchActionIcon.css'
import './BranchAttentionDetailActions.css'
import './CommitDiffFileListFinal.css'
import './StashStyleAuthority.css'
import './ai/AiSettingsLayout.css'
import './ai/AiStage1Polish.css'
import './ai/AiSettingsActionWidth.css'
import './ai/AiReviewNavigation.css'
import './ai/AiReviewStage4.css'
import './ActionButtonSurface.css'
import './SettingsControlSurface.css'
import './ScrollBarSurface.css'
import './SecondaryWindowViewport.css'
import './ButtonInteractionSurface.css'
import './SecondaryWindowChrome.css'
import './SecondaryWindowOptionSurface.css'
import './FormControlSurface.css'
import './CanonicalCheckbox.css'
import './AdaptiveRowContainerAuthority.css'
import './OverlayLayer.css'
import './CommitHistoryHorizontalSurface.css'
import './CommitHistoryHandoffSurface.css'
import './BrandLogoSurface.css'
import { startWindowLifecycleDiagnostics } from './windowLifecycleDiagnostics.js'
import { startWindowScaleGuard } from './windowScaleGuard.js'

const BranchManagementLayer = lazy(() => import('./BranchManagementLayer.jsx'))
const BranchManagementInteractionLayer = lazy(() => import('./BranchManagementInteractionLayer.jsx'))
const BranchAttentionDetailLayer = lazy(() => import('./BranchAttentionDetailLayer.jsx'))
const RepoStashManagerLayer = lazy(() => import('./RepoStashManagerLayer.jsx'))
const WorkingChangesLayer = lazy(() => import('./WorkingChangesLayer.jsx'))
const AiReviewLayer = lazy(() => import('./ai/AiReviewLayer.jsx'))
const AiCommitMessageLayer = lazy(() => import('./ai/AiCommitMessageLayer.jsx'))
const AiSettingsSection = lazy(() => import('./ai/AiSettingsSection.jsx'))

function GitSyncApplication() {
  return (
    <CommitDiffLayer>
      <App />
      <AppTooltipLayer />
      <Suspense fallback={null}>
        <BranchManagementLayer />
        <BranchManagementInteractionLayer />
        <BranchAttentionDetailLayer />
        <RepoStashManagerLayer />
        <WorkingChangesLayer />
        <AiReviewLayer />
        <AiCommitMessageLayer />
        <AiSettingsSection />
      </Suspense>
    </CommitDiffLayer>
  )
}

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <AppBootstrapBoundary>
      <GitSyncApplication />
    </AppBootstrapBoundary>
  </StrictMode>,
)

startWindowLifecycleDiagnostics()
startWindowScaleGuard()
