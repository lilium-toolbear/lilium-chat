# `docs/api-contract/` — Patches, Discussion, Changelog

**本目录不是权威 API 文档。**

Browser/Bot API 的 **唯一 source of truth** 是仓库根下的 [`docs/api-contract.md`](../api-contract.md)。当代码与 contract 冲突时，以 `docs/api-contract.md` 为准并修改实现。

## 目录用途

| 内容 | 说明 |
|---|---|
| `*-contract-addendum.md` | 已合并或进行中的 contract patch / 讨论稿；合并后内容写入 `docs/api-contract.md` 的修订记录与正文，本目录文件保留为历史 trace |
| `README.md` | 本说明 |
| 旧路径 redirect stub | 例如 `2026-06-22-toolbear-chat-api-contract.md` → 指向 `docs/api-contract.md` |

## 变更流程

1. **所有 API wire shape 变更**必须直接修改 `docs/api-contract.md`，并在文内 **修订记录** 增加新版本条目（含日期与 delta 摘要）。
2. 大型或跨阶段变更可先在 `docs/api-contract/` 写 dated addendum 讨论，**定稿后合并进** `docs/api-contract.md`；addendum 文件改为 redirect stub 或标注 superseded。
3. 实现计划与 backend spec 引用 `docs/api-contract.md`，不要以本目录 addendum 作为 normative source。
4. 第三方公开 API 文档从已上线能力抽取；内部 addendum（如 §16）在 product 验证前不对第三方公开。

## 当前文件

| 文件 | 状态 |
|---|---|
| `2026-06-27-dm-api-contract-addendum.md` | 已合并进主 contract v2.13；保留为 patch trace |
| `2026-06-28-bot-slash-command-contract-addendum.md` | 已合并进主 contract v2.16；保留为 patch trace |
| `2026-06-30-bot-internal-api-contract-addendum.md` | 已合并进主 contract §16–§17 (v2.19)；redirect stub |
| `2026-06-22-toolbear-chat-api-contract.md` | redirect stub → `docs/api-contract.md` |
