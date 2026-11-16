# dsh-memory-nian

给 [DeepSeek Harness](https://github.com/deepseek-ai) 用的自托管记忆插件。

## 它解决什么

模型每次开新对话都是白纸——昨天定的方案、前天踩过的坑、上个月说过的偏好，
一概不记得，每次都要重新讲一遍。

这个插件把那些东西存进本机一个 SQLite 文件：新对话开始时自动带进上下文，
聊到相关话题时再把对应条目捞出来。**数据不上传任何服务器**，全程离线可用。

## 三个设计选择

**① 按作用域分层，不按长短分**

核心（跨项目通用的身份、偏好、原则、禁令）→ 项目（这个项目是什么）→
分支（进行中的决策、现状、待办）→ 细节（事实、教训、专题、规程）。

好处是写的时候不用纠结「这条算知识还是算教训」——看它成立的范围有多大就行。
下面有完整的分类表。

**② 中文优先的检索**

CJK bigram 切分 + BM25 打分，额外叠一层拼音和首字母：
「人工智能」写成「人工作站能」也能搜到，`ctgzt` 这种缩写也能。

**③ 零运行时依赖**

只用 Node 自带的 `node:sqlite`（**Node 23.4 起免标志位**；DSH 自带的运行时是 Node 24，
装进 DSH 直接可用）。仓库里的拼音库是**可选增强**，删掉插件照样跑，
只失去同音错字和首字母缩写这两层容错，字面检索不受影响。

## 四层结构

按**作用域从大到小**分四层，每层带一个 `category` 做层内分类。

| 层 | 装什么 | category |
|---|---|---|
| `core` | 跨项目通用：身份、偏好、原则、禁令 | `identity` / `preference` / `principle` / `rule` |
| `project` | 项目的静态画像 | `overview` / `structure` |
| `branch` | 项目里进行中的事，会过时会变 | `decision` / `ops` / `todo` / `quote` |
| `detail` | 最小颗粒的积累 | `fact` / `lesson` / `topic` / `procedure` |

`detail` 的四种最容易被问「这条到底放哪个」：

- `fact` —— 一句话的客观事实（版本号、路径、端口）
- `lesson` —— 现象 + 原因 + 做法。**中文记忆的默认形态**：踩过的坑、摸到的规律都放这
- `topic` —— 一个完整的小专题，可到 3000 字（机制 + 判据 + 反例）
- `procedure` —— 能照着执行的**操作规程**：步骤 + 命令 + 检查清单

`topic` 回答「为什么会这样」，`procedure` 回答「我该按什么顺序做」。
出现「这件事又是零零散散几条、拼不出完整流程」的时候，就是缺 `procedure`。

每层还有一张 `<层>_hist` 版本表：`memory_update` 改动内容之前，
插件会先把旧值整条写进去（不是靠数据库触发器），所以版本历史一定和实际改动同步。

## 十个工具

| 工具 | 用途 |
|---|---|
| `memory_search` | 关键词检索，可按层/项目/状态/天数过滤，按相关度降序 |
| `memory_read` | 按 id 读一条完整内容与元数据（读一次算一次「用过」） |
| `memory_remember` | 写一条新记忆。写入前自动查重，近邻会给提示 |
| `memory_update` | 改内容/关键词/状态/归属；改前自动留快照进版本历史 |
| `memory_project` | 取某个项目的全部记忆，按子类分组 |
| `memory_recent` | 最近写入/更新了哪些 |
| `memory_dream` | 最近 N 天有改动的条目，用来判断哪些该合并（只报告，不改数据） |
| **`memory_timeline`** | **看一条记忆被改过几次、每次改了什么**（数据来自 `*_hist` 版本表） |
| **`memory_health`** | **库体检**：没关键词 / 超长 / 沉底没被读过 / 归属异常 / 项目名重复 |
| **`memory_export`** | **导成 Markdown 文件**，可读、能进 git、能给别的 AI 用 |

每个工具的描述都写清了「什么时候该用它」——模型靠这个选工具，
所以描述不是装饰，是功能的一部分。

> `memory_core`（编辑常驻 MEMORY.md）**默认不注册**：官方 `dsh-core-memory` 已提供同名工具。
> 想让记忆功能完全自足，把配置 `coreTool` 设 `true` 并先禁用 `dsh-core-memory`，否则同名注册会失败。

## 版本历史与时间线

每次 `memory_update` 真正改了内容（标题/正文/关键词/状态/重要性/归属），
都会把**改前的完整快照**写进 `<层>_hist` 表，然后 `memory_timeline` 就能回看：

```
memory_timeline id=<前12位>
① 2026-11-12 10:00  最初版本
② 2026-11-12 11:00  改了：content, importance
   content: 「原来那句」→「新写的那句」
③ 2026-11-12 12:00（当前）  改了：status
```

`hit_count`、`last_accessed_at`、`updated_at` 这几个字段**不记历史** ——
它们每读一次就变，记进去会把历史表刷爆，而且没有追溯价值。

## 三条注入路径

| 路径 | 什么时候 | 注入什么 |
|---|---|---|
| 首轮快照 | 新对话的第一条消息之前 | 核心层的身份 + 偏好 + 原则与禁令(重要性≥2) + 项目清单 |
| 每条命中 | 每条 ≥4 字符的用户消息 | 细节层里按关键词打分取 top-N |
| **压缩后重注入** | 上下文被压成摘要之后 | 长期记忆快照再灌一遍（同一次压缩只灌一次） |

最后一条是专门对付「压缩完就忘事」的：压缩把整段历史折成摘要，
压缩前读过什么、定过什么结论都不在摘要里了，所以压缩后的第一步先把记忆补回去。

另外还有一条提醒：**距上次写记忆已经过了若干轮、且当前在调工具干活**时，
会投一句「这轮有没有值得长期记的」。纯聊天、刚写过、冷却期内都不吭声。

## 和上下文压缩配合

插件**不实现压缩**（那是 DSH 的 `/compact`），但它把压缩前后的两步接上了，靠三个钩子。

**① 落档催办（`agent/pre-step`）**

上下文水位到 `remindTokens`（读 `~/.dsh/auto-checkpoint.json`）时，在模型生成**之前**插一条提醒，
让你先写 `precompact-<session>.md`。走预发（直接进上下文），不弹确认框，不占你一次点击。

拿不到 `agent.session` 时退回轮次判据：每 `precompactEveryTurns` 轮查一次落档新鲜度，
超过 `precompactFreshMs` 没更新就算旧。这样功能不至于哑掉。

**② 落档写完，自己按冲水键（`agent/turn-stopping`）**

同时满足四个条件才压：

- token 超过 `remindTokens`
- 工作区里有 `precompact-*.md`，且是 `precompactJustWrittenMs` 内写的
- 那份落档里有「🔑 这一轮定下的结论」这一节，且不是空的
- 同一份落档没压过

然后开一个后台任务，等 agent 空闲再调 `/compact`。不能在 `turn-stopping` 里直接调——
那时 agent 还没转 idle，会报 `Compaction is unavailable because this process has an active compaction, or the agent is not idle`。
压失败会把标记清掉，允许下次重试。

**③ 压缩完，把记忆再灌一遍（`agent/pre-step`）**

压缩完 DSH 会插一条 `source.kind === 'compact-checkpoint'` 的用户消息，里面带 `compactionId`。
这是 pre-step 里**唯一**能判断「刚压过」的信号。同一个 id 只补注入一次，避免连续几步反复灌。

## 检索为什么对中文友好

- **字面**：CJK bigram 切分（`unicode61` 分词器对中文基本不可用），BM25 打分，
  `k1=1.5` / `b=0.75`。
- **拼音层**：查询和文档都额外生成拼音整串 + 拼音 2-gram。
  所以同音错别字（把「人工智能」写成「人工作站能」）也能命中。
- **首字母层**：2~14 个纯字母的查询额外走独立通道（`ctgzt` 这种缩写）。
  这一层单独加分而不混进主 BM25 —— 否则 `ct`/`tg` 这类满屏的二字组会把真命中淹掉。
- **时间衰减**：`importance < 3` 且非高分命中时按新旧降权；
  高分或高重要性的条目不衰减。
- **命中计数**：`hit_count` 只用于**同分时的平局决胜**，不乘进分数 ——
  避免"被搜到过 → 分更高 → 更容易被搜到"的正反馈。

## 写入时的两道提示

不是"自动合并"，是**告诉调用方发生了什么**：

- **重复**（内容重合 ≥ 65%，Jaccard）：不写，返回已有条目的 id，
  让你决定是用 `memory_update` 合并、还是加 `force: true` 另立。
- **近邻**（重合 30%~65%）：**照写**，但附一句提醒
  ——「这条与 XX 有 47% 重合」。记忆会演化（先说 A、后来改成 B），
  这种情况既不该硬拦，也不该让两条互相打脸的记录悄悄并存。

## 安装

### 方式一：DSH 直接装目录（推荐，不需要 npm 账号）

1. 下载源码：<https://github.com/leinian114514/dsh-memory/archive/refs/heads/main.zip>
2. 解压到任意目录（例如 `<你的插件目录>/dsh-memory`）
3. 打开 DSH → **插件** → **添加插件** → 选那个目录
4. 重启 DSH

不需要 Node、不需要 npm、不需要命令行。

### 方式二：npm（包名 `dsh-memory-nian`）

```bash
dsh plugin add dsh-memory-nian --profile <your-profile>
```

> 注意：这个包**还没发布到 npm**（`dsh-memory` 那个名字已被别人占用）。
> 在它上线之前请用方式一。

装完都重启 DSH。插件自带 `cordis.patch.yml`（`dsh.bundle.patch`），会自动 insert 插件行。

**第一次运行不需要任何准备**：库文件不存在时会自动建表（13 张表 + 15 个索引），
直接就能写。已有旧库也能直接用 —— 同一套 `IF NOT EXISTS` 语句会只补缺的表，不碰数据。

## ⚠️ 插件冲突（装之前先看这段）

DSH 拒绝**同名工具**注册，而且失败是**静默**的 —— 表现是「插件装上了，但工具不见了」。
所以装之前确认没有别的记忆插件占着 `memory_*` 这组名字：

| 冲突源 | 症状 | 处理 |
|---|---|---|
| 别的记忆插件 | 它注册同名的 `memory_search/read/remember/...`，谁先加载谁赢 | 禁用那个插件，或给本插件设 `toolPrefix` |
| `dsh-core-memory` | 它提供 `memory_core`；本插件默认不抢这个名字 | 想完全自足时：禁用它 + `coreTool: true` |
| 其它自写插件 | 同样看名字 | 看日志 |

本插件在注册失败时会**明确打出警告**（红字级别的 `logger.warn`），写明哪些工具没注册上
和两种解法，不会闷声不响：

```
[dsh-memory] ⚠️ 2 个工具没注册成功，几乎都是名字被别的插件占了：
  - memory_search（tool memory_search already registered）
  - memory_remember（...）
  解法一：禁用占名的那个插件（它也注册同名 memory_*）；
  解法二：在本插件配置里设 toolPrefix（例如 "ext_"），工具就会叫 ext_memory_search。
```

## 配置

全部有默认值，不改也能跑。`cordis.patch.yml` · `config` 里可调：

| 键 | 默认 | 说明 |
|---|---|---|
| `dbPath` | `<workspace>/.dsh-memory/memory.db` | 库文件位置 |
| `workspace` | 进程 cwd | 工作区根 |
| `toolPrefix` | `''` | 与别的记忆插件并存时加前缀，避免工具重名被拒注册 |
| `firstTurn` | `true` | 首轮是否做结构化快照注入 |
| `firstTurnMaxChars` | `8000` | 首轮注入的字符上限 |
| `hit` | `true` | 是否做每轮关键词命中注入 |
| `hitTopK` | `2` | 每轮最多注入几条 |
| `reanchor` | `true` | 压缩后是否重注入长期记忆 |
| `precompactNudge` | `true` | 上下文快满时催你写落档（预发，不弹框） |
| `precompactEveryTurns` | `15` | 拿不到 token 水位时，每几轮查一次落档新鲜度 |
| `precompactFreshMs` | `1800000`（30 分钟） | 落档多久没更新算「旧」 |
| `autoCompactAfterPrecompact` | `true` | 落档写完自动调 `/compact` |
| `precompactJustWrittenMs` | `600000`（10 分钟） | 「落档刚写完」的判定窗口 |
| `dedupeJaccard` | `0.65` | 写入查重阈值；设 `1` 等于关掉 |
| `reflect` | `true` | 是否发「该记点什么了」的提醒 |
| `reflectEveryTurns` | `10` | **干满几轮没写记忆才提醒**（按轮次，不按时间） |
| `reflectIdleMs` | `0` | 时间判据，默认关；设成毫秒数则与轮次判据取或 |
| `reflectCooldownMs` | `2400000`（40 分钟） | 两次提醒的最小间隔 |
| `coreTool` | `false` | 是否注册 `memory_core`（需先禁用 `dsh-core-memory`） |
| `debugFile` | 空 | 填路径才写运行日志 |

## 数据与隐私

- 全部数据在 `<workspace>/.dsh-memory/memory.db`，纯本地 SQLite。
- 插件不做任何网络请求。
- 备份就复制这个 `.db` 文件；建议用 SQLite 的 backup API 而不是直接 copy
  （开了 WAL 时直接复制可能漏掉未 checkpoint 的数据）。

## 从别的记忆插件迁过来

数据格式的权威定义就是 `lib/schema.js` 里的建表语句 —— 四张表、每张表的 `category` 取值都在注释里。

做法：写个脚本读旧库，逐条判断该归哪一层哪一类，写进新库。注意三点：

1. **中文记忆通常是「现象+原因+做法」三段一体的**，不要试图把一条拆成「知识」和「教训」，拆不开的；
2. **核心层只放跨项目通用的东西**（身份/偏好/原则/禁令），项目技法一律下沉到 `detail` 并带 `project`；
3. **正文写提炼后的祈使句，别抄原话** —— 原话里的语气词和当时的情绪会每次注入都占位置。
   原话要留就单独存一条 `branch` + `category: quote`。

## 许可

MIT，见 `LICENSE`。第三方组件声明也在 `LICENSE` 里。

作者：**念 (Nian)**
