/**
 * 向量检索（v5，2026-11-20）
 *
 * 为什么加它：实测在真实库里，BM25 在"换说法"的查询上几乎全错 ——
 * 「压缩完还记得刚才说的话是怎么做的」按字面一个词都撞不上
 * 「压缩后补最近几轮原话」，于是返回一堆无关条目；向量比的是意思，能对上。
 * 20 个真实查询里向量赢 6、BM25 赢 1、平 3。
 *
 * 但**不替换 BM25**：字面对得上时 BM25 更稳（第 5 个查询就是它赢）。
 * 两路都跑，用 RRF 合并 —— 谁排前面由两边的排名共同决定，不用去比两种不可比的分数。
 *
 * 依赖是**可选的**：模型不在、@huggingface/transformers 没装，一律优雅降级回 BM25。
 * 插件主打的"零运行时依赖"不能被这个破坏，所以全部走动态 import + try。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const MODEL_DIR = path.join(__dirname, '..', 'models', 'bge-small-zh-v1.5')
const CACHE_VERSION = 1

/**
 * 编码用的线程数。
 *
 * 🛑 2026-11-20 真机事故：第一次用默认线程数给全库上千条编码，
 *    onnxruntime 把**全部核心**吃满，**鼠标都动不了**，5 分钟没跑完。
 *    ⇒ 用「核数 − 4」：留 4 个给系统和语音输入之类的常驻任务。
 *      先前写成死 2 太保守，编码一次要跑好几分钟。
 */
const ENCODE_THREADS = Math.max(1, os.cpus().length - 4)
/** 每编码多少条让出一次事件循环，别把界面拖死 */
const ENCODE_BATCH = 32

/** 编码器单例：第一次用才加载（约 240ms），之后复用 */
let encoderPromise = null

/**
 * 拿一个 encode 函数。拿不到就返回 null（调用方据此退回 BM25）。
 * @returns {Promise<null | ((texts: string[]) => Promise<Float32Array[]>)}
 */
export function getEncoder() {
  if (encoderPromise) return encoderPromise
  encoderPromise = (async () => {
    try {
      if (!fs.existsSync(path.join(MODEL_DIR, 'onnx', 'model.onnx'))) return null
      const { pipeline, env } = await import('@huggingface/transformers')
      // 只从本地目录找模型：Node 的 fetch 不走 HF_ENDPOINT，直连 huggingface.co 会超时
      env.allowRemoteModels = false
      env.localModelPath = path.join(__dirname, '..', 'models')
      const pipe = await pipeline('feature-extraction', 'bge-small-zh-v1.5', {
        dtype: 'fp32',
        local_files_only: true,
        // 🛑 线程数必须显式限死：默认会吃满所有核（真机实测把鼠标都卡住了）
        session_options: {
          intraOpNumThreads: ENCODE_THREADS,
          interOpNumThreads: 1,
        },
      })
      return async (texts) => {
        // 分批 + 每批之间让出事件循环：一次丢上千条进去会长时间占住主线程
        const all = []
        for (let i = 0; i < texts.length; i += ENCODE_BATCH) {
          const chunk = texts.slice(i, i + ENCODE_BATCH)
          const out = await pipe(chunk, { pooling: 'mean', normalize: true })
          const dim = out.dims[out.dims.length - 1]
          for (let k = 0; k < chunk.length; k++) {
            all.push(out.data.slice(k * dim, (k + 1) * dim))
          }
          if (i + ENCODE_BATCH < texts.length) {
            await new Promise((r) => setImmediate(r))
          }
        }
        return all
      }
    } catch {
      return null
    }
  })()
  return encoderPromise
}

/** 向量缓存文件：跟着记忆库走，别放插件目录（每个工作区一份） */
const cachePathOf = (workspace) => path.join(workspace, '.dsh-memory', 'vec-cache.bin')

/**
 * 读缓存，或者给全库重新编码。
 *
 * 为什么缓存：上千条编码一次要几十秒，而条目没变就不该重算。
 * 用 `id + updated_at` 的指纹判断有没有变过 —— 任何一条改了或删了，整份重算
 * （条目数量级小，增量维护的复杂度不值得）。
 *
 * @returns {Promise<null | {ids: string[], vecs: Float32Array, dim: number}>}
 */
export async function loadDocVectors(workspace, docs, opts = {}) {
  const encode = await getEncoder()
  if (!encode) return null
  const cachePath = opts.cachePath || cachePathOf(workspace)
  // 指纹：id + updated_at，排好序拼起来再哈希
  const sig = docs
    .map((d) => `${d.id}:${d.updated_at || 0}`)
    .sort()
    .join('|')
  const sigHash = simpleHash(sig)

  try {
    const raw = fs.readFileSync(cachePath)
    const head = JSON.parse(raw.subarray(0, raw.indexOf(10)).toString('utf8'))
    if (
      head.v === CACHE_VERSION &&
      head.sig === sigHash &&
      head.dim > 0 &&
      head.n === docs.length
    ) {
      const buf = raw.subarray(raw.indexOf(10) + 1)
      // 🛑 不能直接 `new Float32Array(buf.buffer, buf.byteOffset, n)` ——
      //    那要求 byteOffset 是 **4 的倍数**，而缓存头（JSON+\n）的长度碰巧不对齐时
      //    会抛 RangeError，被上面的 catch 吞掉 → 每次都"缓存未命中"→ 全库重算。
      //    真机实测：明明缓存是对的（指纹、大小、条数全对），却每次都要重跑 38 秒。
      //    slice 一份出来对齐，4.7MB 拷贝几毫秒，比重新编码 38 秒便宜太多。
      const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.length)
      const vecs = new Float32Array(ab)
      return { ids: head.ids, vecs, dim: head.dim }
    }
  } catch {
    /* 没缓存 / 坏了 → 重算 */
  }

  if (docs.length === 0) return null
  // 🛑 不要把 content 截太短：实测截 512 字时向量质量明显下降
  //    （同一个查询，Python 版用全文能排第 1，截断后排到第 3）。
  //    记忆条目本来也就 200~2000 字，全带上代价很小。
  const texts = docs.map((d) => `${d.title || ''}\n${String(d.content || '').slice(0, 2000)}`.trim())
  const list = await encode(texts)
  const dim = list[0] ? list[0].length : 0
  if (!dim) return null
  const vecs = new Float32Array(docs.length * dim)
  for (let i = 0; i < list.length; i++) vecs.set(list[i], i * dim)

  try {
    fs.mkdirSync(path.dirname(cachePath), { recursive: true })
    const head = Buffer.from(
      JSON.stringify({ v: CACHE_VERSION, sig: sigHash, n: docs.length, dim, ids: docs.map((d) => d.id) }) + '\n',
      'utf8',
    )
    fs.writeFileSync(cachePath, Buffer.concat([head, Buffer.from(vecs.buffer, vecs.byteOffset, vecs.byteLength)]))
  } catch {
    /* 写不进缓存不算错，下次重算 */
  }
  return { ids: docs.map((d) => d.id), vecs, dim }
}

/** 余弦 topK（向量已经归一化，点积就是余弦） */
export function vectorTopK(queryVec, store, k = 20) {
  const { ids, vecs, dim } = store
  const n = ids.length
  const scores = new Float32Array(n)
  for (let i = 0; i < n; i++) {
    let s = 0
    const base = i * dim
    for (let j = 0; j < dim; j++) s += vecs[base + j] * queryVec[j]
    scores[i] = s
  }
  const order = Array.from({ length: n }, (_, i) => i)
  order.sort((a, b) => scores[b] - scores[a])
  return order.slice(0, k).map((i) => ({ id: ids[i], score: scores[i] }))
}

/**
 * RRF 合并两路结果。
 *
 * 为什么不用"分数加权求和"：BM25 分和余弦相似度量纲完全不同
 * （实测 BM25 能到 75，余弦最大 1），归一化又会把两边的分布形状压平。
 * RRF 只看**排名**，天然免疫量纲问题，是混合检索的常规做法。
 */
export function rrfMerge(lists, opts = {}) {
  const k = opts.k || 60
  // 🛑 两路**不能等权**：实测等权时，BM25 排第一的那条错条目只要在向量列表里
  //    也进了前 24，两项一加还是第一，混合反而把纯向量的好结果挤掉。
  //    向量赢在"换说法也能找到"，BM25 只在字面对得上时稳 —— 所以给 BM25 降权。
  const weights = Array.isArray(opts.weights) ? opts.weights : []
  const acc = new Map()
  lists.forEach((list, li) => {
    if (!Array.isArray(list)) return
    const w = Number.isFinite(weights[li]) ? weights[li] : 1
    list.forEach((hit, rank) => {
      const cur = acc.get(hit.id) || { id: hit.id, score: 0, hits: [] }
      cur.score += w / (k + rank + 1)
      cur.hits.push(hit)
      acc.set(hit.id, cur)
    })
  })
  return [...acc.values()].sort((a, b) => b.score - a.score)
}

function simpleHash(s) {
  let h = 5387
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0
  return (h >>> 0).toString(36) + '-' + s.length
}

/**
 * 混合检索：BM25 的结果 + 向量结果，用 RRF 合并。
 *
 * 为什么要混合而不是直接换掉 BM25：实测 20 个真实查询里，
 * 向量在"换说法"时能救回 BM25 完全找不到的条目（赢 6 个），
 * 但字面对得上时 BM25 更稳（有 1 个查询是它赢）。两路都要。
 *
 * **任何一步失败都返回 null，调用方据此静默退回纯 BM25** ——
 * 搜索不能因为"向量没装好"而挂掉。
 *
 * @returns {Promise<null | string[]>} 合并后的 id 顺序（不含未命中的）
 */
export async function hybridRank(workspace, docs, query, bm25Hits, opts = {}) {
  try {
    const store = await loadDocVectors(workspace, docs, opts)
    if (!store) return null
    const encode = await getEncoder()
    if (!encode) return null
    const [qv] = await encode([String(query || '').slice(0, 512)])
    if (!qv) return null
    const vh = vectorTopK(qv, store, opts.vectorK || 30)
    const bm = (Array.isArray(bm25Hits) ? bm25Hits : []).map((h) => ({ id: h.id }))
    const merged = rrfMerge([bm, vh], { k: opts.rrfK || 60 })
    return merged.map((m) => m.id)
  } catch {
    return null
  }
}
