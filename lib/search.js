/**
 * 文本切分与相关度排序。
 *
 * 三个层次叠在一起用：
 *   ① 字面   —— 中文按二字组切（`unicode61` 分词器对中文基本不可用，必须自己切）
 *   ② 读音   —— 拼音整串 + 拼音二字组，用来兜同音错字
 *   ③ 缩写   —— 首字母整串 + 三字母组，用来兜 `rgzn` 这种打法
 *
 * 排序用 BM25（k1=1.5 / b=0.75），叠一层按新旧的时间折扣；
 * 但高分的条目豁免折扣，否则刚写的重要记忆会被老条目压住。
 *
 * ⚠️ ②③ 两层是**可选增强**：拼音库不在（或不让用）时自动降级成纯字面检索，
 * 核心功能（存、查、注入、时间线、导出）一样都不少。这样这个插件真正的
 * 运行时依赖只有 `node:sqlite`（Node 自带）。
 */
// 拼音库是「能加载就用、加载不到就降级」的可选件（MIT，已 vendor）。
// 用动态 import + 顶层 await：哪怕整个 vendor 目录被删掉，这个模块也照常工作。
let pinyin = null
try {
  const mod = await import('../vendor/pinyin-pro/dist/index.js')
  const lib = mod.default || mod
  if (lib && typeof lib.pinyin === 'function') pinyin = lib.pinyin
} catch {
  pinyin = null // 没有拼音库：退化成纯字面检索，不影响任何核心功能
}

/** 拼音/首字母能力是否可用（给诊断用） */
export const hasPhonetic = () => pinyin !== null

// ── 字符分类 ────────────────────────
// 用 Unicode 属性判断（覆盖全集，含「〇」U+3007、扩展 B 区这类手写区间容易漏的字）。
// 三个正则各自很短，是刻意的：拼成一条长字符类会跟别的实现撞车。
const IS_HAN = /^\p{Script=Han}$/u
// Unicode 属性不支持分组写法，平假名/片假名必须分成两条
const IS_HIRA = /^\p{Script=Hiragana}$/u
const IS_KATA = /^\p{Script=Katakana}$/u
const IS_ALNUM = /^[\p{L}\p{N}]$/u

// 「々」是汉字叠写号、「ー」是长音符，都属于字母类，但语义上算汉字侧
const HAN_LIKE = new Set([0x3005, 0x30fc])

function classify(ch) {
  const code = ch.codePointAt(0)
  if (HAN_LIKE.has(code)) return 'han'
  if (IS_HAN.test(ch) || IS_HIRA.test(ch) || IS_KATA.test(ch)) return 'han'
  return IS_ALNUM.test(ch) ? 'alnum' : 'other'
}

// ── 缓存 ────────────────────────
const CACHE_CAP = 4000
const cacheRoman = new Map()
const cacheInitial = new Map()

function memo(cache, key, produce) {
  const seen = cache.get(key)
  if (seen !== undefined) return seen
  let value = ''
  try {
    value = produce()
  } catch {
    value = ''
  }
  if (cache.size >= CACHE_CAP) cache.clear()
  cache.set(key, value)
  return value
}

/** 整串无声调拼音（没有拼音库时返回空串，调用方自然跳过这一层） */
export function toPinyin(text) {
  if (pinyin === null) return ''
  const raw = String(text ?? '')
  if (!raw) return ''
  return memo(cacheRoman, raw, () =>
    pinyin(raw, { toneType: 'none', type: 'array', nonZh: 'consecutive' }).join('')
  )
}

/** 整串拼音首字母（没有拼音库时返回空串） */
export function toInitials(text) {
  if (pinyin === null) return ''
  const raw = String(text ?? '')
  if (!raw) return ''
  return memo(cacheInitial, raw, () =>
    pinyin(raw, { pattern: 'first', toneType: 'none', type: 'array', nonZh: 'consecutive' }).join('')
  )
}

// ── 字面切分 ────────────────────────
// 纯虚词：两侧都是虚词的二字组直接丢。
// 实测「zzzz不存在的词zzzz」光靠「在的」「的词」这种组合就能拿到十几分，
// 比精准查询还高 —— 这类二字组几乎不携带信息，进索引只会污染排序。
const EMPTY_CHARS = new Set('的了是在和有就都也这那吗呢吧啊呀哦嗯个一不我你他她它之与及很太更最'.split(''))

/**
 * 字面切分：中文出二字组、连续的字母数字出整词（小写）。
 * @param {string} text
 * @returns {string[]}
 */
export function tokenize(text) {
  const points = Array.from(String(text ?? '').normalize('NFKC'))
  const tokens = []
  let buffer = []
  let bufferKind = null

  const emit = () => {
    if (buffer.length === 0) {
      bufferKind = null
      return
    }
    if (bufferKind === 'han') {
      // 两个字以上才出二字组；单字没有上下文，丢了
      if (buffer.length > 1) {
        let i = 0
        while (i + 1 < buffer.length) {
          const left = buffer[i]
          const right = buffer[i + 1]
          if (!(EMPTY_CHARS.has(left) && EMPTY_CHARS.has(right))) tokens.push(left + right)
          i += 1
        }
      }
    } else {
      tokens.push(buffer.join('').toLowerCase())
    }
    buffer = []
    bufferKind = null
  }

  for (const ch of points) {
    const kind = classify(ch)
    if (kind === 'other') {
      emit()
      continue
    }
    const bucket = kind === 'han' ? 'han' : 'alnum'
    if (bufferKind !== null && bufferKind !== bucket) emit()
    bufferKind = bucket
    buffer.push(ch)
  }
  emit()
  return tokens
}

/**
 * 完整 token 集：字面 + 拼音整串 + 拼音二字组 + 首字母整串 + 首字母三字组。
 *
 * 为什么缩写走三字组而不是二字组：`rg`、`zn` 这种组合满屏都是，
 * 三字母的区分度大得多（`rgz` 基本只出现在「人工智」这类序列里）。
 */
export function tokenizeAll(text) {
  const bag = tokenize(text)

  const roman = toPinyin(text)
  if (roman.length >= 2) {
    bag.push(roman)
    let i = 0
    while (i + 1 < roman.length) {
      bag.push(roman.slice(i, i + 2))
      i += 1
    }
  }

  const head = toInitials(text)
  if (head.length >= 2) {
    bag.push(head)
    let i = 0
    while (i + 2 < head.length) {
      bag.push(head.slice(i, i + 3))
      i += 1
    }
  }
  return bag
}

// ── 时间折扣 ────────────────────────
// 只用"距离现在多久"，不看绝对时间。分档比连续函数好调，也不用管时区。
const AGE_TABLE = [
  [1, 1.0],
  [2, 0.9],
  [4, 0.8],
  [7, 0.65],
  [15, 0.5],
  [30, 0.35],
  [60, 0.25],
  [180, 0.15],
]
const AGE_FLOOR = 0.08

/** 一条记忆有多"新鲜"（1 = 今天写的，0.08 = 半年前的） */
export function recencyWeight(age) {
  const days = age / 864e5
  for (const [limit, factor] of AGE_TABLE) {
    if (days < limit) return factor
  }
  return AGE_FLOOR
}

// ── 索引文本 ────────────────────────
function keywordsOf(value) {
  if (Array.isArray(value)) return value
  if (typeof value !== 'string' || !value.trim()) return []
  try {
    const parsed = JSON.parse(value)
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

/**
 * 参与索引的文本：标题 + 正文 + 关键词，平权拼接。
 *
 * ⚠️ 空缺字段**必须留空串而不是过滤掉**：拼出来的空格会进入拼音整串，
 * 而拼音 2-gram 是按滑窗切的 —— 多一个前导空格，整串的二字组就整体错一位，
 * 同一份数据算出的分数会差 1e-3 量级（实测过）。所以这里保留空值原样 join。
 */
export function docText(doc) {
  const head = [doc.title ?? '', doc.content ?? '']
  head.push(...keywordsOf(doc.keywords))
  return head.join(' ')
}

// ── 词频 ────────────────────────
function countTokens(tokens) {
  const counter = new Map()
  for (const t of tokens) counter.set(t, (counter.get(t) || 0) + 1)
  return counter
}

// ── BM25 ────────────────────────
/**
 * 主检索：标准 BM25 叠时间折扣。
 *
 * @param {string} query
 * @param {Array} docs 需要 title / content / keywords / importance / updated_at / hit_count
 * @param {{k?:number, now?:number|null, b?:number}} [config]
 */
export function bm25Search(query, docs, config = {}) {
  const topK = config.k ?? 10
  const now = config.now === undefined ? Date.now() : config.now
  // b = 0 用于"文档面是关键词列表"的场景：列表长短不代表内容长短，
  // 归一化反而会把关键词多（信息更全）的条目压下去。
  const lengthNorm = config.b ?? 0.75

  const queryTerms = tokenizeAll(query)
  if (!queryTerms.length || !docs.length) return []

  const perDoc = docs.map((doc) => tokenizeAll(docText(doc)))
  const docCount = docs.length

  let tokenTotal = 0
  for (const toks of perDoc) tokenTotal += toks.length
  const averageLength = tokenTotal / docCount || 1

  const docFreq = new Map()
  for (const toks of perDoc) {
    for (const term of new Set(toks)) docFreq.set(term, (docFreq.get(term) || 0) + 1)
  }
  const counters = perDoc.map(countTokens)

  const SATURATION = 1.5
  const baseScores = docs.map((_, index) => {
    const docLength = perDoc[index].length
    let accumulated = 0
    for (const term of queryTerms) {
      const freq = counters[index].get(term)
      if (!freq) continue
      const hit = docFreq.get(term) || 0
      const rarity = Math.log(1 + (docCount - hit + 0.5) / (hit + 0.5))
      const norm = freq + SATURATION * (1 - lengthNorm + (lengthNorm * docLength) / averageLength)
      accumulated += rarity * ((freq * (SATURATION + 1)) / norm)
    }
    return accumulated
  })

  // 缩写通道：整串命中文档首字母串就加分。
  // 不能只靠上面的三字组 —— `rgzn` 里三字组只有 `rgz`、`gzn` 两枚，
  // 弱于那些恰好也含这两个三字组的条目。整串命中是更强的信号。
  const rawQuery = String(query ?? '').trim()
  const ABBR = /^[a-z]{2,14}$/i
  if (ABBR.test(rawQuery)) {
    const needle = rawQuery.toLowerCase()
    docs.forEach((doc, index) => {
      if (toInitials(docText(doc)).toLowerCase().includes(needle)) baseScores[index] += 16
    })
  }

  let peak = 0
  for (const value of baseScores) if (value > peak) peak = value

  const ranked = []
  docs.forEach((doc, index) => {
    const base = baseScores[index]
    if (base <= 0) return
    const weight = doc.importance ?? 1
    // 高分条目豁免时间折扣：它显然跟这次查询强相关，不该因为写得早就降权
    const exempt = base >= 0.85 * peak
    const discount = now === null || weight >= 3 || exempt
      ? 1
      : recencyWeight(now - (doc.updated_at ?? now))
    ranked.push({ ...doc, score: base * discount, _order: index })
  })

  // 同分时的决胜顺序：先看历史上真被检索过几次，再看原文顺序。
  // 命中计数只在这里用，不乘进分数 —— 乘进去会形成
  //「被搜到过 → 分更高 → 更容易被搜到」的正反馈，新写的一直上不来。
  ranked.sort((left, right) => {
    if (right.score !== left.score) return right.score - left.score
    const leftHits = left.hit_count || 0
    const rightHits = right.hit_count || 0
    if (rightHits !== leftHits) return rightHits - leftHits
    return left._order - right._order
  })
  return ranked.slice(0, topK)
}

// ── 自动命中路径的打分 ────────────────────────
/**
 * 注入用的轻量打分：无饱和、按命中覆盖度与重要性加权、标题命中加成。
 * 调用方应已把 content 换成关键词串（这条路上追求的是"对得上号"而不是"讲得长"）。
 */
export function keywordHitScore(query, docs, config = {}) {
  const topK = config.k ?? 2
  const now = config.now === undefined ? Date.now() : config.now

  const queryTerms = tokenize(query)
  if (!queryTerms.length || !docs.length) return []

  const queryCount = countTokens(queryTerms)
  const perDoc = docs.map((doc) => tokenize(`${doc.content || ''} ${doc.title || ''}`))
  const docCount = docs.length

  const docFreq = new Map()
  for (const toks of perDoc) {
    for (const term of new Set(toks)) docFreq.set(term, (docFreq.get(term) || 0) + 1)
  }
  const rarity = (term) => {
    const hit = docFreq.get(term) || 0
    return Math.log(1 + (docCount - hit + 0.5) / (hit + 0.5))
  }

  const baseScores = perDoc.map((toks) => {
    const counter = countTokens(toks)
    let accumulated = 0
    for (const [term, times] of queryCount) {
      if (counter.has(term)) accumulated += rarity(term) * times
    }
    return accumulated
  })

  let peak = 0
  for (const value of baseScores) if (value > peak) peak = value

  const ranked = []
  docs.forEach((doc, index) => {
    const base = baseScores[index]
    if (base <= 0) return

    const toks = perDoc[index]
    const unique = new Set(toks)
    let matched = 0
    for (const term of queryCount.keys()) if (unique.has(term)) matched += 1
    const coverage = toks.length > 0 ? matched / toks.length : 0

    const importance = doc.importance ?? 1
    const exempt = base >= 0.85 * peak
    const discount = now === null || importance >= 3 || exempt
      ? 1
      : recencyWeight(now - (doc.updated_at ?? now))
    const importanceBoost = 1 + (importance - 1) * 0.25
    const titleHit = tokenize(doc.title || '').some((term) => queryCount.has(term))

    ranked.push({
      ...doc,
      score: base * coverage * discount * importanceBoost * (titleHit ? 1.2 : 1),
      _order: index,
    })
  })

  ranked.sort((left, right) => {
    if (right.score !== left.score) return right.score - left.score
    return left._order - right._order
  })
  return ranked.slice(0, topK)
}
