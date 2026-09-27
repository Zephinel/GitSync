import { defineIcon } from '../icons/iconDefinitions.js'

export const BOOTSTRAP_LOADING_MARK = defineIcon({
  svg: { fill: 'currentColor' },
  elements: [{
    type: 'path',
    d: 'M5 4H19V6H5V4ZM4 9H20V20H4V9ZM6 11V18H18V11H6ZM8 13H16V15H8V13Z',
  }],
})
