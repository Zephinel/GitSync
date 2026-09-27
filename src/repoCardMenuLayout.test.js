import test from 'node:test'
import assert from 'node:assert/strict'
import {
  getRepoCardFloatingLayout,
  getRepoCardFloatingHoverBridgeLayout,
  getRepoCardMoreMenuLayout,
  getRepoCardMoreMenuPlacement,
  isRepoCardMoreMenuAnchorVisible,
  REPO_CARD_FLOATING_ALIGNMENT,
  REPO_CARD_MORE_MENU_PLACEMENT,
} from './repoCardMenuLayout.js'

test('repo card menu opens below when there is enough lower viewport space', () => {
  assert.equal(
    getRepoCardMoreMenuPlacement(
      { top: 180, bottom: 220 },
      240,
      520
    ),
    REPO_CARD_MORE_MENU_PLACEMENT.bottom
  )
})

test('repo card menu flips above when lower space cannot fit and upper space is larger', () => {
  assert.equal(
    getRepoCardMoreMenuPlacement(
      { top: 420, bottom: 460 },
      220,
      500
    ),
    REPO_CARD_MORE_MENU_PLACEMENT.top
  )
})

test('repo card menu layout is fixed to the trigger while staying inside the viewport', () => {
  assert.deepEqual(
    getRepoCardMoreMenuLayout(
      { top: 180, bottom: 220, left: 610, right: 760 },
      { width: 300, height: 260 },
      { width: 800, height: 500 }
    ),
    {
      placement: REPO_CARD_MORE_MENU_PLACEMENT.bottom,
      top: 228,
      left: 460,
      maxHeight: 260,
    }
  )
})

test('repo card menu clamps top placement to available upper space', () => {
  assert.deepEqual(
    getRepoCardMoreMenuLayout(
      { top: 90, bottom: 130, left: 40, right: 160 },
      { width: 220, height: 220 },
      { width: 360, height: 180 }
    ),
    {
      placement: REPO_CARD_MORE_MENU_PLACEMENT.top,
      top: 12,
      left: 12,
      maxHeight: 70,
    }
  )
})

test('repo card menu anchor visibility detects viewport intersection', () => {
  assert.equal(
    isRepoCardMoreMenuAnchorVisible(
      { top: 20, bottom: 60, left: 320, right: 460 },
      { width: 800, height: 500 }
    ),
    true
  )
  assert.equal(
    isRepoCardMoreMenuAnchorVisible(
      { top: -80, bottom: -20, left: 320, right: 460 },
      { width: 800, height: 500 }
    ),
    false
  )
  assert.equal(
    isRepoCardMoreMenuAnchorVisible(
      { top: 520, bottom: 560, left: 320, right: 460 },
      { width: 800, height: 500 }
    ),
    false
  )
})

test('repo card floating layout can left-align metadata hover cards', () => {
  assert.deepEqual(
    getRepoCardFloatingLayout(
      { top: 120, bottom: 144, left: 48, right: 220 },
      { width: 300, height: 180 },
      { width: 800, height: 500 },
      { horizontalAlignment: REPO_CARD_FLOATING_ALIGNMENT.left }
    ),
    {
      placement: REPO_CARD_MORE_MENU_PLACEMENT.bottom,
      top: 152,
      left: 48,
      maxHeight: 336,
    }
  )
})

test('repo card floating layout keeps metadata hover cards inside right viewport edge', () => {
  assert.deepEqual(
    getRepoCardFloatingLayout(
      { top: 300, bottom: 324, left: 700, right: 780 },
      { width: 260, height: 180 },
      { width: 800, height: 420 },
      { horizontalAlignment: REPO_CARD_FLOATING_ALIGNMENT.left }
    ),
    {
      placement: REPO_CARD_MORE_MENU_PLACEMENT.top,
      top: 112,
      left: 528,
      maxHeight: 280,
    }
  )
})

test('repo card hover bridge connects the trigger to a lower fixed hover card', () => {
  const anchorRect = { top: 120, bottom: 144, left: 48, right: 220 }
  const floatingRect = { width: 300, height: 180 }
  const floatingLayout = getRepoCardFloatingLayout(
    anchorRect,
    floatingRect,
    { width: 800, height: 500 },
    { horizontalAlignment: REPO_CARD_FLOATING_ALIGNMENT.left }
  )

  assert.deepEqual(
    getRepoCardFloatingHoverBridgeLayout(
      anchorRect,
      floatingRect,
      floatingLayout,
      { width: 800, height: 500 }
    ),
    {
      top: 144,
      left: 40,
      width: 316,
      height: 8,
    }
  )
})

test('repo card hover bridge connects the trigger to an upper fixed hover card', () => {
  const anchorRect = { top: 300, bottom: 324, left: 700, right: 780 }
  const floatingRect = { width: 260, height: 180 }
  const floatingLayout = getRepoCardFloatingLayout(
    anchorRect,
    floatingRect,
    { width: 800, height: 420 },
    { horizontalAlignment: REPO_CARD_FLOATING_ALIGNMENT.left }
  )

  assert.deepEqual(
    getRepoCardFloatingHoverBridgeLayout(
      anchorRect,
      floatingRect,
      floatingLayout,
      { width: 800, height: 420 }
    ),
    {
      top: 292,
      left: 520,
      width: 276,
      height: 8,
    }
  )
})
