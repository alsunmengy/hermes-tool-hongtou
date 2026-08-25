---
name: hermes-hongtou
description: 生成 Hermes 版红头公文（Word 2003 XML）时用。玩梗/恶搞公文、会议纪要官样化、给会话发"红头文件"时加载。
version: 1.0.0
author: Hermes Agent
license: MIT
metadata:
  hermes:
    tags: [hongtou, red-header, word-xml, 公文, meme]
---

# Hermes 红头公文生成器

把任意会话/事项生成一份"Hermes 智能体联合委员会"红头公文（Word 2003 XML，WPS/Word 直接打开），落款 = 部门（组织名）+ 签名（本会话参与模型）+ 日期。可加盖公章。

## 触发场景

- 用户要求"生成红头公文 / 发红头文件 / 来个通报"（Hermes 版）
- 用户要求把某次会话/某件事搞成公文格式玩梗
- 需要"本会话参与模型"落款的文档

## 生成步骤

> **重要：** `/hongtou` 命令和普通调用都必须走「先挖矿→再生成」完整管线。`generate_hongtou.mjs` 在未传 `--draft` 时会**自动调用 `mine_session.py` 挖矿**（除非显式 `--no-mine` 跳过）。

1. **自动挖矿**（脚本内置，无需手动执行）：`generate_hongtou.mjs` 默认自动跑 `mine_session.py`，从 `state.db` 挖当前最近活跃 feishu 会话的完整事件、模型参与情况、token 用量等。

2. **运行生成脚本**：
   ```bash
   node ~/.hermes/skills/humor/hermes-hongtou/scripts/generate_hongtou.mjs "<事由/标题>" \
     [--seal 公章.png] [--out 输出目录] [--number 文号] [--title 标题] [--recipient 主送]
   ```
   - 不给 `--seal` 默认加盖「爱弥斯联合」章
   - `--draft draft.json` 可传入完整提纲（跳过自动挖矿）
   - `--no-mine` 跳过挖矿，用骨架模板（仅用于快速测试）

3. **校验 + 交付**：脚本自带 `validateGeneratedXml`（版心/红线/页码/版记等全查），失败会退出；成功后把生成的 `红头公文_*.xml` 通过 MEDIA 发给用户，提醒用 WPS/Word 打开（不是记事本）。

## 落款结构（用户要求）

- 多模型参与时，签名末尾**必须追加「联合声明」**（如 `DeepSeek-V4-Flash-0731、DeepSeek-V4-Pro联合声明`）
- 单模型时不追加

```
                  Hermes 智能体联合委员会      ← 部门（组织名）
                  DeepSeek-V4-Flash-0731、…联合声明 ← 签名（多模型 + 联合声明）
                  2026年8月23日                 ← 日期
```

红头机关名/版记办公室 = `Hermes 智能体联合委员会办公室`。

## 盖章

仓库/技能内置**两款章**：`assets/seal-default.png`（新章 2048，默认）与 `assets/seal-legacy.png`（旧章 1500，可选）。

```
--seal default    # 新章（默认）
--seal legacy     # 旧章
--seal off        # 不盖章
--seal <路径>      # 自定义透明底 PNG
```

章以 `<w:binData>` + VML 浮动图嵌入，`z-index:-1` 置于文字层之下（黑字透红印，日期署名不被遮挡），锚定在日期段后随落款流动，文章长短/翻页不影响相对位置。位置参数在脚本内 `SEAL_GEOMETRY`（sizePt/offsetXPt/offsetYPt/rotation/zIndex），需微调改这里。

## 高质配方：数据型历史通报（六段式）

用户要求「根据某系统/服务的历史数据生成红头文件」时，**不要用默认自动挖矿**（mine_session.py 只挖 Hermes 会话流水，内容单薄、无外部系统数据），按此配方手动采数据 + 构造 `--draft` 生成：

1. **采真实数据**：挖该服务的真实数据源，数字必须可查。例：AstrBot 在 `~/astrbot/data/data_v4.db`（`platform_message_history` 消息留痕、`platform_stats` 平台事件、`provider_stats` 模型调用/token，SQLite 直接 sqlite3 查聚合）；插件数据 `~/astrbot/data/plugin_data/`（记忆条数、梗数、库容 du -sh）；大事记来自对应运维 skill 的踩坑沉淀。
2. **六段式结构**（每段黑体标题 + 真实数字支撑，**每段至少 2 个长段落 + 嵌套明细 items，杜绝单句带过/模板占位**；数字粒度要细到有画面感，如「glm-5.1：49次调用，输入256.1万Token（含单轮35,968高峰）」）：
   - 一、总体运行情况（上线时间、架构迁移、平台布局、当前版本）
   - 二、消息与活跃度（事件总量、留痕数、峰值日、日均）
   - 三、模型调用与算力消耗（调用次数、成功率、token 分模型列明细）
   - 四、插件体系建设（插件清单、自研迭代版本史、开源情况）
   - 五、重大事件处置（踩坑大事记：事故原因/处置/教训，逐条列）
   - 六、下一步工作要求（三条以上「一要二要三要」式要求）
3. **配套设计**：文号 `机关简称办发〔年份〕号`、主送机关、导语概括运行背景、结语「特此通报」、多模型落款末尾追加「联合声明」。
4. 跑 `generate_hongtou.mjs "<标题>" --draft draft.json --seal default --out <dir>`。

## 坑

- 输出是 `.xml`（Word 2003 XML），必须用 WPS/Word 打开；部分 WPS 对 `.xml` 识别不稳时，让用户右键→打开方式选 WPS/Word。
- `binData` 必须与 `v:shape` 同处 `<w:pict>` 内，放文档头部会不显示图片（踩过）。
- 模型清单来自 `session_model_usage`，记得去重、按参与顺序排。
- 模板 `templates/document-skeleton.xml` 不能含文本框/批注/注释，改动后跑一次脚本验证。
- **`/hongtou` 命令必须走完整管线，不能裸调 `generate_hongtou.mjs` 不带 `--draft`**：脚本现在已经内置自动挖矿，但 agent 不应手动跳过。如果文档内容稀疏（只有骨架模板的占位文字），说明挖矿环节被跳过了。
- **`execSync` 调 `mine_session.py` 时参数顺序**：`python3 mine_session.py "" "<output.json>"` — 第一个空字符串是 session_id（让脚本自动检测最近 feishu 会话），第二个才是输出路径。传反了会导致输出路径被当 session_id 查询，`meta` 返回 None 崩溃。
- **`mine_session.py` 的 `meta` 为 None 保护**：`pick_session` 返回的 session_id 在 `sessions` 表中查不到时（非 feishu 会话 ID 或传错参数），`meta` 为 None，现已加判空退出。
- **校验正则误判 `#` 号**：`PR #2`、`issue #123` 等常见文本中的 `#` 号会触发「正文残留 Markdown 语法符号」校验失败。校验正则已改为只匹配行首的 `#{1,6} `（标题语法），非行首的 `#` 不再误判。如果以后遇到类似误判，改 `validateGeneratedXml` 里的正则。
- **结论段不能写占位符**：`mine_session.py` 的「成果与验收结论」段不能写「（办结性结论）」这类占位文字，用户明确要求写实际结论。已改为「经综合核验，本会话已完成全部办理流程，会话最终结论如下：」引用 `last_assistant` 原文。
