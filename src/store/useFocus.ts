import { create } from 'zustand'
import { bridge, isElectron } from '../lib/bridge'
import { kvGet, kvSet } from '../lib/idb'
import { FocusAccumulator, emptyFocusSnapshot, sanitizeFocusSnapshot, scheduledFocusIntervals, type FocusSnapshot, type FocusWindowState } from '../lib/focus'
import type { PlanSchedule } from '../lib/types'

export interface FocusStore {
  ready: boolean
  enabled: boolean
  tracking: boolean
  windowState: FocusWindowState | null
  snapshot: FocusSnapshot
  error: string | null
  setEnabled: (enabled: boolean) => void
  reset: () => Promise<void>
}
// Keep the legacy key/version: optional session records migrate without losing aggregates.
const KEY = 'focus.v1.aggregate'
const PREFERENCE_KEY = 'focus.v1.enabled'
let writes: Promise<void> = Promise.resolve()
let lifecycle: Promise<void> = Promise.resolve()
let owned = false
let stopSession = () => {}
let restartSession = () => {}
let resetSession = () => {}

// All preference, reset and aggregate writes share one queue. A reset cannot be
// overwritten by a previously queued heartbeat or a StrictMode teardown.
function save(key: string, value: unknown): Promise<void> {
  writes = writes.then(() => kvSet(key, value)).catch(() => {
    useFocus.setState({ error: '专注设置或统计无法保存。' })
  })
  return writes
}
export const useFocus = create<FocusStore>(() => ({
  ready: false, enabled: false, tracking: false, windowState: null,
  snapshot: emptyFocusSnapshot(), error: null,
  setEnabled: (enabled) => {
    if (!useFocus.getState().ready || enabled === useFocus.getState().enabled) return
    stopSession()
    useFocus.setState({ enabled, tracking: false, windowState: null, error: null })
    void save(PREFERENCE_KEY, enabled)
    if (enabled) restartSession()
  },
  reset: async () => {
    if (!useFocus.getState().ready) return
    resetSession()
    const snapshot = emptyFocusSnapshot()
    useFocus.setState({ snapshot, error: null })
    await save(KEY, snapshot)
  },
}))

/** App-level owner. Disabled monitoring installs no native focus listeners and
 * polls no planner data. Each enabled session has a fresh cursor (no replay).
 */
export function startFocusMonitoring(): () => void {
  if (owned) return () => {}
  owned = true
  let stopped = false
  let endSession = () => {}
  let generation = 0
  const stop = () => {
    generation++
    endSession()
    endSession = () => {}
    resetSession = () => {}
    useFocus.setState({ tracking: false, windowState: null })
  }
  const start = () => {
    if (stopped || !useFocus.getState().enabled) return
    if (!isElectron) {
      useFocus.setState({ error: '专注监测仅在桌面应用中可用。' })
      return
    }
    const token = ++generation
    const live = () => !stopped && token === generation && useFocus.getState().enabled
    let accumulator = new FocusAccumulator(Date.now, useFocus.getState().snapshot)
    let schedule: PlanSchedule | null = null
    let state: FocusWindowState | null = null
    let sequence = -1
    let refreshing = false
    let pendingRefresh = false
    const publish = () => {
      const now = Date.now()
      accumulator.setIntervals(state ? scheduledFocusIntervals(schedule, now) : [], now)
      useFocus.setState({ tracking: !!state && scheduledFocusIntervals(schedule, now).some(i => i.start <= now && now < i.end), windowState: state, snapshot: accumulator.snapshot() })
    }
    const persist = () => void save(KEY, accumulator.snapshot())
    const observe = (next: FocusWindowState) => {
      if (!live() || !Number.isSafeInteger(next.sequence) || next.sequence < sequence) return
      sequence = next.sequence
      state = next
      // Receipt time is authoritative: native timestamps may predate initialization
      // or have been queued during sleep. Never backfill an unobserved interval.
      accumulator.observe(next)
      publish()
    }
    const refresh = async () => {
      if (!live()) return
      if (refreshing) { pendingRefresh = true; return }
      refreshing = true
      try {
        // Reminder pause is intentionally irrelevant to this independent opt-in feature.
        const nextSchedule: PlanSchedule | null = await bridge.planner.getSchedule()
        if (!live()) return
        accumulator.advance()
        schedule = nextSchedule
        publish()
        useFocus.setState({ error: null })
      } catch {
        if (live()) {
          schedule = null
          publish()
          useFocus.setState({ error: '时间规划不可用，专注监测暂时停止。' })
        }
      } finally {
        refreshing = false
        if (pendingRefresh && live()) { pendingRefresh = false; void refresh() }
      }
    }
    let querying = false
    const queryFocus = async () => {
      if (!live() || querying) return
      querying = true
      try {
        const current = await bridge.win.getFocusState()
        if (!live()) return
        if (current) observe(current)
        else {
          state = null
          publish()
          useFocus.setState({ error: '主窗口状态不可用，专注监测暂时停止。' })
        }
      } catch {
        if (live()) {
          state = null
          publish()
          useFocus.setState({ error: '主窗口状态不可用，专注监测暂时停止。' })
        }
      } finally { querying = false }
    }
    const offFocus = bridge.win.onFocusState(observe)
    const offPlanner = bridge.planner.onEvent(() => void refresh())
    // A heartbeat closes small observed intervals. After a long delay the pure
    // accumulator drops the gap and censors the bout; re-query before continuing.
    const tick = setInterval(() => {
      if (!live()) return
      publish()
      void queryFocus()
    }, 1000)
    const poll = setInterval(() => { if (live()) { void refresh(); persist() } }, 5000)
    const onPageHide = () => { if (live()) { accumulator.suspend(); accumulator.setIntervals([]); state = null; publish(); persist() } }
    const onPageShow = () => { if (live()) { void refresh(); void queryFocus() } }
    window.addEventListener('pagehide', onPageHide)
    window.addEventListener('pageshow', onPageShow)
    resetSession = () => {
      // Reset aggregates, session records and unfinished spans without changing consent.
      accumulator = new FocusAccumulator(Date.now)
      publish()
      if (state) accumulator.observe(state)
    }
    endSession = () => {
      clearInterval(tick); clearInterval(poll)
      offFocus(); offPlanner()
      window.removeEventListener('pagehide', onPageHide)
      window.removeEventListener('pageshow', onPageShow)
      accumulator.suspend()
      useFocus.setState({ snapshot: accumulator.snapshot() })
      persist()
    }
    void refresh()
    void queryFocus()
  }
  lifecycle = lifecycle.then(async () => {
    await writes
    if (stopped) return
    const [initial, enabled] = await Promise.all([
      kvGet<FocusSnapshot>(KEY, emptyFocusSnapshot()), kvGet<unknown>(PREFERENCE_KEY, false),
    ])
    if (stopped) return
    useFocus.setState({ ready: true, enabled: enabled === true, snapshot: sanitizeFocusSnapshot(initial), error: null })
    stopSession = stop
    restartSession = start
    start()
  }).catch(() => {
    if (!stopped) useFocus.setState({ ready: true, enabled: false, error: '专注监测无法初始化。' })
  })
  return () => {
    stopped = true
    owned = false
    stop()
    stopSession = () => {}
    restartSession = () => {}
  }
}
