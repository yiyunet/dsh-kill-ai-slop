/**
 * 推进建议（三段式，0.7.0）。
 *
 * ★ 为什么把它从 readinessOf 里拆出来：
 *   "能不能给整份交付下结论" 和 "现在能不能开工" 是**两个问题**。
 *   0.6.0 把它们绑在一起 —— 只要综合分不出，结论就只能写"无法判断"，
 *   于是局部未知（比如附件没随文）把整份文件的有用建议一起吞掉。
 *
 * ★ 0.7.0 的分法：
 *     ① 哪些工作已有充分依据、可以推进
 *     ② 哪些工作需要补充或确认
 *     ③ 是否具备给出整份交付结论的依据
 *   只有缺失信息**影响核心方向**时，才暂缓整体判断；局部未知只挡它自己。
 */

import { STARTABLE_AT } from './layers.mjs'

const labelOf = item => item.label ?? item.cell ?? '待确认项'

/**
 * @param {{cells: object[], gaps: object[], pending: object[], composite: object}} input
 */
export function adviceOf({ cells = [], gaps = [], pending = [], composite = {}, shortfalls = [] } = {}) {
  const rated = cells.filter(cell => cell.state === 'rated')
  const direction = gaps.filter(gap => gap.affects === 'direction')
  const local = gaps.filter(gap => gap.affects === 'local' || gap.affects === undefined)

  // `blocks` 只挡它自己：pending 项可带 affects='local' 表示"只挡这件事"。
  // 未标 affects 时按 direction 处理（保守：不知道影响什么，就不能说结论已经具备）。
  const blocking = pending.filter(item => item.blocks === true)
  const blockingEverything = blocking.filter(item => item.affects !== 'local')

  const canStartNow = []
  const mustDo = []
  const mustWait = []

  // ★ 0.7.13：推进结论必须落到**具体动作**。
  //   旧版列的是「I1 已给出的部分」—— 读起来没错，看完还是不知道先干什么。
  //   现在直接读合并后的工作缺口，给"这件事要补什么"。
  const directionShort = shortfalls.filter(item => item.affects === 'direction')
  const localShort = shortfalls.filter(item => item.affects !== 'direction')
  const actionOf = item => (item.nextAction === '' ? '补上这一项' : item.nextAction)

  if (shortfalls.length > 0) {
    for (const item of directionShort) {
      mustDo.push(`${item.title} —— ${actionOf(item)}（**要先定方向**）`)
    }
    for (const item of localShort) {
      mustDo.push(`${item.title} —— ${actionOf(item)}`)
    }
    canStartNow.push(`上面 ${shortfalls.length} 项之外的内容不受影响，可以先用`)
  } else {
    // 模型没给缺口清单 → 退回按格列（旧行为），但说清这是降级
    for (const gap of direction) mustDo.push(`${gap.cell ?? '—'}：${gap.work ?? '核心方向需要重新选择'}（核心方向）`)
    for (const gap of local) mustDo.push(`${gap.cell ?? '—'}：${gap.work ?? '局部安排不足'}`)
    for (const cell of rated.filter(item => item.score >= STARTABLE_AT)) {
      canStartNow.push(`${cell.id} ${cell.label}（${cell.score} 分）已给出的部分`)
    }
  }

  for (const item of pending) {
    if (item.blocks !== true) canStartNow.push(`不依赖「${labelOf(item)}」的部分`)
  }

  for (const item of blocking) {
    mustWait.push(`${labelOf(item)}（挡住：${item.blocksWhat ?? item.work ?? '相关判断'}）`)
  }

  let conclusionReady
  let conclusionNote
  if (rated.length === 0) {
    conclusionReady = false
    conclusionNote = '本轮没有可用的判定（没有评审记录，或全部判定未通过核对），无法给出整份交付的结论。'
  } else if (direction.length > 0 || directionShort.length > 0) {
    conclusionReady = false
    conclusionNote = '存在影响核心方向的缺口 —— 整份交付的结论要等方向定下来；先把范围澄清清楚，再判断是否需要重选。'
  } else if (blockingEverything.length > 0) {
    conclusionReady = false
    conclusionNote = `有 ${blockingEverything.length} 项未知会影响核心判断（${blockingEverything.map(labelOf).join('、')}）—— 整份结论暂缓，其余部分可以继续。`
  } else {
    conclusionReady = true
    conclusionNote = composite.withheld === true
      ? '个别层或缺项未出分，但那只影响分数，不影响"哪些可以做、哪些要补"这三段判断。'
      : ''
  }

  return {
    conclusionReady,
    conclusionNote,
    canStartNow: dedupe(canStartNow),
    mustDo,
    mustWait,
    blocking: blocking.map(item => ({ label: labelOf(item), blocksWhat: item.blocksWhat ?? item.work ?? '' })),
  }
}

function dedupe(list) {
  return [...new Set(list)]
}
