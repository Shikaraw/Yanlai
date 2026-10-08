import React from 'react'
import { createRoot } from 'react-dom/client'
import 'katex/dist/katex.min.css'
import 'highlight.js/styles/github-dark-dimmed.css'
import './styles/app.css'
import { App } from './App'
import { ReminderApp } from './views/ReminderApp'

/**
 * Two entry surfaces share one bundle:
 *  - `#reminder?...`  the frameless always-on-top popup window
 *  - everything else  the main application shell
 */
const hash = window.location.hash || ''
const isReminder = /^#reminder/.test(hash)

if (isReminder || hash) {
  document.documentElement.dataset.theme = 'dark'
}

const root = createRoot(document.getElementById('root')!)

if (isReminder) {
  document.body.style.background = 'transparent'
  root.render(
    <React.StrictMode>
      <ReminderApp />
    </React.StrictMode>,
  )
} else {
  root.render(
    <React.StrictMode>
      <App />
    </React.StrictMode>,
  )
}
