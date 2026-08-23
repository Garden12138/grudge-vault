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

Day One 官方说明 macOS 支持通过 `File → Export` 导出 JSON，ZIP 可包含条目与分类后的照片、视频、音频和 PDF；因此它适合作为历史导入格式。重复导入将优先按 Entry UUID 和修改信息做幂等更新。后续可增加导入目录监听，但不会依赖 Day One 内部数据库结构。

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

Case Binder、本地模型、多源自动同步和主动周期回顾将在基础闭环稳定后逐步加入。阶段顺序用于表达依赖关系，可根据真实使用反馈调整，不作为僵硬范围合同。

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
- [架构决策记录](docs/adr/)
- [产品构想参考对话](https://chatgpt.com/share/6a8b0514-1c4c-83ea-aacf-e1d4971390fa)

## 当前状态

Phase 0 Developer Preview 已建立可运行基础：

- Electron + React + TypeScript Monorepo 与安全的 Main / Preload / Renderer 边界；
- 可创建、打开并自动恢复最近的本地工作区；
- SQLite 迁移、WAL、Asset repository 与可恢复 Job Runner；
- 由系统密钥存储保护的 Workspace Key；
- AES-256-GCM 加密、SHA-256 内容寻址的对象保险库；
- 文件拖入、哈希展示、完整性校验和任务重试 UI；
- lint、typecheck、unit/integration/E2E、生产构建与三平台 CI 打包基线。

快速启动：

```bash
pnpm install
pnpm dev
```

当前版本尚不包含 Chat、Event 编辑、搜索、Day One 导入和模型能力；这些功能按[分阶段开发计划](docs/DEVELOPMENT_PLAN.md)继续交付。

> Grudge Vault 可以帮助整理材料和准备问题，但涉及法律结论时，应结合所在地、事发时点与具体事实核验有效规则，并在需要时咨询专业人士。
