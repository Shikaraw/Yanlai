import { Icon } from '../components/Icons'
import { Modal } from '../components/ui'
import { clsx } from '../lib/util'
import type { PlanItem } from '../lib/types'

export function CopyDaysModal({
  open, days, selected, sourceDay, item, onToggle, onClose, onApply,
}: {
  open: boolean
  days: Array<{ n: number; label: string }>
  selected: string[]
  sourceDay: string
  item: PlanItem | null
  onToggle: (day: string) => void
  onClose: () => void
  onApply: () => void
}) {
  return (
    <Modal open={open} onClose={onClose} title="复制到其他天" icon="copy" footer={<>
      <button className="btn" onClick={onClose}>取消</button>
      <button className="btn primary" disabled={!selected.length} onClick={onApply}>复制到 {selected.length} 天</button>
    </>}>
      <div className="col" style={{ gap: 13 }}>
        <div className="card-sub">{item?.title || '当前时段'} · 源日：{days.find((d) => String(d.n) === sourceDay)?.label || sourceDay}</div>
        <div className="row wrap" style={{ gap: 8 }}>
          {days.map((d) => {
            const key = String(d.n)
            const disabled = key === sourceDay
            return <button key={key} className={clsx('chip', selected.includes(key) && 'accent')} disabled={disabled} onClick={() => onToggle(key)}>{d.label}{disabled ? '（源日）' : ''}</button>
          })}
        </div>
      </div>
    </Modal>
  )
}
