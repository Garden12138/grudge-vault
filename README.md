# Grudge Vault（记仇账本）

> 一个 Local-first 的个人事件记忆、证据保险库与策略 Harness Agent。

Grudge Vault 通过对话、日记和多媒体，持续构建属于用户自己的长期事件记忆。它不只是保存“不愉快”，还会把零散记录整理成可检索、可关联、可补全、可回顾的事件；当事情涉及工作、合同、金钱、消费或其他权益时，它也能协助梳理事实、材料和行动选项。

“记仇”是产品人格，理性地保存记忆、理解模式并保护自身利益，才是产品价值。

## 产品闭环

```text
发生事情
   ↓
对话 / 日记 / 文件留痕
   ↓
提取或补全 Event
   ↓
关联人物、来源、证据与历史事件
   ↓
回顾、分析、发现重复模式
   ↓
形成行动选项；必要时整理为 Case Binder
```

## 核心能力

- **轻量记录**：以 Agent Chat 为主要入口，自然描述即可创建事件，不要求先填写复杂表单。
- **事件记忆**：围绕 Event 组织时间、人物、事实、情绪、利益、来源、材料和关联事件。
- **历史回填**：导入 Day One 日记，将原始日记保留为 Source Memory，再逐步提取 Candidate Event。
- **待补全箱**：对日期、金额、人物或经过不明确的记录显式标记，并通过编辑或对话持续补全。
- **多媒体理解**：接收图片、音频、视频、PDF 和其他文件；保留原件，单独保存 OCR、转写和分析结果。
- **检索与回顾**：按关键词、人物、时间、主题和语义检索，生成时间线、人物视角和周期回顾。
- **事件分析**：区分事实、证据、解释与情绪，结合历史模式给出风险、选择及其可能代价。
- **证据与 Case**：为权益相关事件整理时间线、证据目录、缺失材料和来源校验信息。
- **Harness Agent**：Agent 通过明确的工具读取和更新本地记忆，而不是把全部数据塞进一次模型对话。

## 关键产品原则

1. **Local-first**：数据默认保存在本机，用户掌握文件、导出与删除权。
2. **Chat 是入口，Event 是核心**：对话负责降低输入成本，结构化事件承载长期价值。
3. **原始内容、派生内容、分析结果分层**：AI 不覆盖原始日记或原始材料。
4. **事实、证据、解释、情绪分开表达**：避免把主观判断自动升级为事实。
5. **不确定性可见**：允许“大约 9 月”“约 5000 元”“来自用户回忆”这样的信息存在，不伪造精度。
6. **修改可追溯**：补充和纠正形成修订历史，保留信息从何而来、为何变化。
7. **策略服务于用户**：提供选项和推演，帮助用户处于更有利的位置，而不是替用户作决定。

## 记忆模型

Grudge Vault 将长期记忆拆成四层：

| 层级 | 主要内容 | 作用 |
| --- | --- | --- |
| Raw Memory | Day One 导出、聊天输入、图片、音频、视频、文件 | 保存原始输入 |
| Source Memory | Journal Entry、Message、Transcript、Media、Document | 形成可引用的来源 |
| Event Memory | Event、Person、Relation、Timeline、Candidate、Clarification | 形成可关联的事件记忆 |
| Case / Strategy Memory | Case、Evidence、Pattern、Risk、Action、Decision | 支持权益整理和策略分析 |

`JournalEntry` 不等于 `Event`。一篇日记可能不产生事件，也可能产生多个候选事件；信息不足时，系统应创建待补全项，而不是猜测缺失事实。

## Day One 接入

第一条稳定路径是导入 Day One 官方 JSON ZIP：

```text
Day One JSON ZIP
   ↓
校验、解包与去重
   ↓
JournalEntry + Media
   ↓
候选事件提取
   ↓
用户确认 / 合并 / 补全
```

Day One 官方说明 macOS 支持通过 `File → Export` 导出 JSON，ZIP 可包含条目与分类后的照片、视频、音频和 PDF；因此它适合作为历史导入格式。重复导入将优先按 Entry UUID 和修改信息做幂等更新。桌面端也可监听用户明确选择的外部目录，稳定后增量摄取顶层 ZIP；不会读取 Day One 内部数据库结构，也不会在应用关闭时后台运行。

- [Day One：Exporting entries](https://dayoneapp.com/guides/tips-and-tutorials/exporting-entries/)
- [Day One：Command Line Interface](https://dayoneapp.com/guides/day-one-for-mac/command-line-interface-cli/)（官方 CLI 当前用于创建条目，不能导出已有数据）

## 首个可用版本

首个完整可用闭环聚焦：

- 对话记录与手动编辑事件；
- 图片、音频、视频和文档附件；
- 原始材料哈希与派生内容分离；
- Day One JSON ZIP 导入和幂等更新；
- 候选事件、待补全箱与修订历史；
- 全文搜索、人物关联和时间线回顾；
- 基于工具调用的 Agent 检索与结构化分析。

内置本地模型、多源自动同步和新采集入口将在基础闭环稳定后逐步加入。阶段顺序用于表达依赖关系，可根据真实使用反馈调整，不作为僵硬范围合同。

## 建议实现基线

当前建议以桌面端优先：

- Electron + React + TypeScript 构建桌面应用与 Agent Runtime；
- SQLite + FTS5 保存结构化数据并提供全文检索；
- 本地文件保险库保存原始对象和派生对象；
- SQLite 任务表驱动可恢复的导入、OCR、转写、索引与分析任务；
- 模型、Embedding、OCR、ASR 和视频处理均通过 Adapter 接入，可选择完全本地或用户明确启用的增强模式。

技术选型是首选实现基线，不是长期锁定。领域模型、工具协议和存储接口会保持独立，使后续替换桌面壳、模型或索引实现时不必重写产品核心。

## 文档

- [架构设计与实现](docs/ARCHITECTURE.md)
- [分阶段开发计划](docs/DEVELOPMENT_PLAN.md)
- [开发与验证](docs/DEVELOPMENT.md)
- [Case Binder 格式 v1](docs/CASE_BINDER_FORMAT.md)
- [架构决策记录](docs/adr/)
- [产品构想参考对话](https://chatgpt.com/share/6a8b0514-1c4c-83ea-aacf-e1d4971390fa)

## 当前状态

Phase 6 Core 已完成本地媒体智能、Day One 增量目录与持续回顾闭环，并保留 Phase 1—5 的记录、Evidence、Case 与安全迁移能力：

- Electron + React + TypeScript Monorepo 与安全的 Main / Preload / Renderer 边界；
- 可创建、打开并自动恢复最近的本地工作区，支持中英文切换；
- 多会话 Chat 先保存原始 Message，再用离线规则生成候选 Event；
- 事件确认、编辑、归档、人物、模糊时间、事实/解释、情绪、利益和待补全项；
- 追加式 EventRevision、乐观并发控制以及来源引用；
- SQLite FTS5 关键词搜索与状态、人物、时间过滤；
- 由系统密钥存储保护、带 key ID 与 epoch 的 Workspace Key Ring，以及手动/空闲/休眠/锁屏锁定；
- 使用异步 scrypt 与 AES-256-GCM、绑定工作区和 epoch、包含迁移中全部 key slots 的显式 `.gvrecovery` 恢复包；
- GVOB v2 随机内容密钥、认证信封、SHA-256 内容寻址与可中断/继续的流式对象和凭证密钥迁移；
- 事件附件关联、常见格式受控预览、导出副本、完整性校验和任务重试；
- 带 manifest 和文件哈希校验的同账户加密工作区快照与恢复；
- Day One JSON ZIP 安全校验、流式解析、原始 ZIP 与媒体加密入库；
- 用户选择的外部 Day One Import Folder 顶层 ZIP 初扫、事件监听、5 分钟对账、稳定性检查与归档 SHA-256 去重；
- Entry UUID / 稳定指纹幂等导入、追加式 SourceVersion 与逐条错误报告；
- 可按导入批次、日期和标签限定的可恢复 Backfill，支持暂停、恢复和取消；
- 离线确定性候选检测、来源段落定位，以及确认、忽略和无字段覆盖的合并审阅；
- 人物别名、保守重复建议、非破坏性 canonical identity 合并与撤回；
- 带算法版本和具体依据的事件关系建议、确认、拒绝与手工关联；
- Event、当前 Day One SourceVersion、OCR 和 Transcript 的统一 FTS5 搜索；
- 可插拔本地 Embedding Adapter、原子 generation 重建、RRF 混合排序与无模型降级；
- People、Timeline、Search 和 Review 视图，以及可跳回 Event/Source 的引用；
- 月度、季度和自定义区间的确定性回顾、过期标记与全局待补全优先级；
- 默认完全离线的确定性 Private Agent，以及仅允许 loopback 的可选本地 OpenAI 兼容端点；
- 默认关闭的 Enhanced Agent、HTTPS 端点约束、上下文脱敏、按新增数据类别重新确认与外发哈希审计；
- 版本化 Tool Registry、Intent Router、受限 Context Builder、标准非流式函数调用循环与确定性失败降级；
- Agent Run、工具调用、引用、待确认写入和模型调用审计的 SQLite v5 持久化；
- 结构化事实、争议/未知、解释、情绪、利益、风险和可逆行动选项，以及 Event/Source/Asset 引用跳转；
- 写入提案批准/拒绝、expected revision 冲突保护、`actor: agent` 修订和单条明确 Clarification 的对话内回答；
- Workspace Key 派生边界内的 AES-256-GCM API 凭证加密，Renderer 只获得 `credentialConfigured` 状态；
- 独立的 Evidence 视图、30 天默认全库完整性巡检、逐项结果、删除影响、墓碑和不改写引用的替换状态；
- 原件与只读 DerivedArtifact 的可信分类，以及 Event/事实/Source/Import/Case 引用投影；
- 追加修订 Case、多币种十进制金额、争议点、问题、材料缺口、Evidence-to-Statement 映射和动态 Case Timeline；
- 完全离线、只生成外部核验问题且随 Case 修订过期的 Legal Information Adapter；
- 明确预览和遮盖 profile 后，由用户点击导出的普通目录 Case Binder，包含 PDF、JSON、原件/派生物、manifest 和 POSIX SHA-256 清单；
- Agent Tool Registry v3 的来源种类与派生物引用、Evidence intent、Case/Evidence/Timeline/Gap 工具、Case 写入审批与不可由模型触发的最终 Binder 导出或媒体批处理；
- 用户安装的 Tesseract/Poppler 图片与 PDF OCR，以及 FFmpeg/whisper.cpp 音频转写；可执行文件和模型只通过系统对话框选择，不自动下载或联网；
- 受限子进程、资源档位、超时/输出/临时空间上限、单任务取消，以及锁定时的明文临时文件清理和任务重排；
- 加密、版本化的 OCR/Transcript `DerivedArtifact`，输入哈希复用、当前版本投影、历史版本保留及失败不切换搜索索引；
- 解锁后每 15 分钟检查的月度/季度 Review 和 ISO 周待补全摘要，稳定调度键、应用内 Reminder，以及默认关闭且仅含通用文案的系统通知；
- SQLite v7、workspace/backup manifest v2，以及媒体派生物、Reminder、混合密钥、完整性、Case、Legal 与 Binder 审计状态的快照恢复；
- lint、typecheck、unit/integration/E2E、生产构建与三平台 CI 打包基线。

快速启动：

```bash
pnpm install
pnpm dev
```

当前版本尚不包含超大 ZIP 专项优化、视频理解、图像/PDF 像素级脱敏、内置 Embedding/LLM/媒体模型、多设备同步、新数据源或 CLI/移动端/浏览器入口；这些功能按[分阶段开发计划](docs/DEVELOPMENT_PLAN.md)继续交付。应用不会分发或下载模型：本地媒体引擎由用户自行安装和选择；Private 可连接用户已有的 loopback OpenAI 兼容服务，Enhanced 仅在用户配置 HTTPS 兼容端点并确认本次新增外发类别（包括 `ocr_excerpt`）后启用。未注入 Embedding Adapter 时语义检索显示为不可用并完整回退关键词检索。SQLite 中的事件、消息、Day One 来源正文、OCR/Transcript 搜索正文、Case、Agent 派生结果和可选向量仍是本地未加密元数据；原始 ZIP、二进制媒体和完整派生对象已认证加密。引擎、模型与 Import Folder 的绝对路径仅保存在权限为 `0600` 的机器级配置中，不进入工作区、备份、任务载荷或日志。

> Grudge Vault 可以帮助整理材料和准备问题，但涉及法律结论时，应结合所在地、事发时点与具体事实核验有效规则，并在需要时咨询专业人士。
