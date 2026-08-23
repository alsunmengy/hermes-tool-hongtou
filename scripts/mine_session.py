#!/usr/bin/env python3
"""扫描 Hermes 会话库 state.db，挖掘原始会话事件，生成红头公文"数据驱动"提纲 draft JSON。

尊重每一位劳动同志：后台任务（标题生成/工具审批/后台审查/子任务/作业调度）全部计入，
并在"模型参与情况"一节按实际承担的 task 逐个点名致敬。

用法：
  mine_session.py [session_id] [输出.json]
  （缺省 session_id 时取最近活跃的 feishu 会话）
"""
import sqlite3, json, sys, os, re, datetime

DB = os.path.expanduser("~/.hermes/state.db")
ORG = "Hermes 智能体联合委员会"

# 事件类型分类规则（按 tool_name 归类为"主要事件类型"）
TYPE_RULES = [
    (r"terminal|process|bash|pwsh", "工具与命令执行"),
    (r"read_file|write_file|patch|search_files", "文件读写与检索"),
    (r"web_search|web_extract|web|fetch|browser", "网络检索与浏览"),
    (r"delegate_task|subagent", "子任务委派"),
    (r"cronjob|job|scheduled", "后台作业调度"),
    (r"vision|image|tts|audio|speech|media", "多模态与媒体"),
    (r"memory|skill|session_search", "记忆与技能"),
    (r"feishu|send|message|chat", "消息与推送"),
]


def classify(tool):
    if not tool:
        return "事件记录"
    for pat, label in TYPE_RULES:
        if re.search(pat, tool, re.I):
            return label
    return "其他工具"


def pick_session(con, sid=None):
    if sid:
        return sid
    row = con.execute(
        'SELECT id FROM sessions WHERE source="feishu" ORDER BY last_activity_at DESC LIMIT 1'
    ).fetchone()
    return row[0] if row else None


def parse_args(argv):
    if argv and argv[0] == "--day":
        return {"day": argv[1] if len(argv) > 1 else None, "sid": None, "out": argv[2] if len(argv) > 2 else None}
    return {"day": None, "sid": argv[0] if len(argv) > 0 else None, "out": argv[1] if len(argv) > 1 else None}


def pick_day_sessions(con, day):
    d0 = datetime.datetime.strptime(day, "%Y-%m-%d")
    d1 = d0 + datetime.timedelta(days=1)
    t0, t1 = d0.timestamp(), d1.timestamp()
    rows = con.execute(
        'SELECT id FROM sessions WHERE source="feishu" AND last_activity_at >= ? AND last_activity_at < ? ORDER BY last_activity_at',
        (t0, t1),
    ).fetchall()
    return [r[0] for r in rows]


def main():
    args = parse_args(sys.argv[1:])
    out_path = args["out"]
    con = sqlite3.connect(DB)
    if args["day"]:
        sids = pick_day_sessions(con, args["day"])
        if not sids:
            print(f"{args['day']} 无 feishu 会话", file=sys.stderr)
            sys.exit(1)
        sid_label = f"{args['day']} 当日会话汇总"
        title = sid_label
        sess_model = ""
    else:
        sids = [pick_session(con, args["sid"])]
        if not sids[0]:
            print("未找到 feishu 会话", file=sys.stderr)
            sys.exit(1)
        sid_label = sids[0]
        meta = con.execute(
            "SELECT title, started_at, message_count, model FROM sessions WHERE id=?", (sids[0],)
        ).fetchone()
        title = meta[0]
        sess_model = meta[3]

    in_clause = ",".join("?" * len(sids))
    rows = con.execute(
        f"SELECT role, tool_name, content, timestamp, active FROM messages WHERE session_id IN ({in_clause}) ORDER BY timestamp",
        sids,
    ).fetchall()

    role_cnt = {"user": 0, "assistant": 0, "tool": 0}
    tool_cnt = {}
    type_cnt = {}
    trail = []
    first_user = ""
    last_assistant = ""
    bg_events = []  # 后台/子任务/作业类执行记录

    for role, tool, content, ts, active in rows:
        if not active:
            continue
        role = role or "unknown"
        role_cnt[role] = role_cnt.get(role, 0) + 1
        if role == "tool" and tool:
            tool_cnt[tool] = tool_cnt.get(tool, 0) + 1
            tc = classify(tool)
            type_cnt[tc] = type_cnt.get(tc, 0) + 1
            trail.append(tool)
            if re.search(r"delegate|subagent|cron|job|background|notify", tool, re.I):
                bg_events.append(tool)
        if role == "user" and not first_user:
            text = re.sub(r"\s+", " ", (content or "")).strip()
            if text and not text.startswith("[System"):
                first_user = text[:200]
        if role == "assistant" and content:
            text = re.sub(r"\s+", " ", content).strip()
            if text and not text.startswith("[System"):
                last_assistant = text[:240]

    # 模型参与情况：按模型合并（一个模型承担的所有任务并入一条，不拆分）
    from collections import OrderedDict
    model_rows = con.execute(
        f"""SELECT model, task, api_call_count, billing_provider
           FROM session_model_usage WHERE session_id IN ({in_clause})
           ORDER BY first_seen ASC""",
        sids,
    ).fetchall()
    groups = OrderedDict()
    for m, task, calls, prov in model_rows:
        role_label = {
            "": "主对话执行",
            "title_generation": "会话标题生成",
            "approval": "工具调用审批",
            "background_review": "会话压缩后台审查",
        }.get(task or "", task or "主对话执行")
        if m not in groups:
            groups[m] = {"tasks": [], "providers": []}
        entry = f"{role_label}{calls}次" if calls else role_label
        if entry not in groups[m]["tasks"]:
            groups[m]["tasks"].append(entry)
        if prov and prov not in groups[m]["providers"]:
            groups[m]["providers"].append(prov)
    model_names = list(groups.keys())
    model_items = [
        f"{m}（{'、'.join(g['tasks'])}，{'/'.join(g['providers']) or '未知供应商'}）"
        for m, g in groups.items()
    ]

    total = sum(role_cnt.values())
    if not model_names:
        model_names = [sess_model or "DeepSeek-V4-Flash-0731"]

    # Token 用量与执行统计（按会话聚合）
    token_rows = con.execute(
        f"""SELECT SUM(input_tokens), SUM(output_tokens), SUM(cache_read_tokens), SUM(cache_write_tokens),
           SUM(reasoning_tokens), SUM(api_call_count), SUM(message_count), SUM(tool_call_count)
           FROM sessions WHERE id IN ({in_clause})""",
        sids,
    ).fetchone()
    tin, tout, c_r, c_w, reasoning, api_calls, rounds, steps = token_rows
    tin = tin or 0; tout = tout or 0; c_r = c_r or 0; c_w = c_w or 0
    reasoning = reasoning or 0; api_calls = api_calls or 0; rounds = rounds or 0; steps = steps or 0
    cache_hit = (c_r / (tin + c_r) * 100) if (tin + c_r) > 0 else 0

    def token_str(n):
        if n >= 1_000_000:
            return f"{n/1_000_000:.1f}M"
        if n >= 1_000:
            return f"{n/1_000:.1f}K"
        return str(n)

    token_items = [
        f"输入用量：{token_str(tin)} tokens",
        f"输出用量：{token_str(tout)} tokens",
        f"缓存命中量：{token_str(c_r)} tokens（命中率 {cache_hit:.1f}%）",
        f"缓存写入量：{token_str(c_w)} tokens",
        f"推理用量：{token_str(reasoning)} tokens",
        f"API 调用次数：{api_calls} 次",
        f"对话轮次：{rounds} 轮",
        f"工具执行步数：{steps} 步",
    ]

    # 执行记录去重计数
    trail_summary = [
        f"{t}×{n}次" for t, n in sorted(tool_cnt.items(), key=lambda kv: -kv[1])[:14]
    ]
    type_summary = [
        f"{k}（{v}条）" for k, v in sorted(type_cnt.items(), key=lambda kv: -kv[1])
    ]

    draft = {
        "issuer": ORG,
        "documentNumber": f"Hermes发〔{datetime.datetime.now().year}〕{int(datetime.datetime.now().strftime('%m'))}号",
        "title": f"{ORG}关于{title or '本会话事项'}的办理情况通报",
        "recipient": "各受理窗口、各模型实例、相关运维组：",
        "lead": f"本通报依据{sid_label}的完整事件日志整理，共核验原始会话事件 {total} 条，现将办理情况通报如下。",
        "sections": [
            {
                "title": "事项起因与背景",
                "paragraphs": [f"本事项源于会话提出的工作诉求，核心内容围绕「{title or '本会话事项'}」展开，已纳入本次办理范围。"],
                "items": [],
            },
            {
                "title": "原始会话事件与主要事件类型",
                "paragraphs": [
                    f"本次共核验原始会话事件 {total} 条，其中用户消息 {role_cnt['user']} 条、助手回复 {role_cnt['assistant']} 条、工具与执行记录 {role_cnt['tool']} 条。",
                    f"按事件类型分类：{'；'.join(type_summary) or '无可分类事件'}。",
                ],
                "items": [],
            },
            {
                "title": "办理过程工具、命令、子任务与后台执行记录",
                "paragraphs": [
                    f"办理过程中共识别工具、命令、子任务或后台作业执行记录：{'、'.join(trail_summary) or '未识别到可提取的技术执行记录'}。",
                ],
                "items": ([f"后台及子任务执行记录：{'、'.join(sorted(set(bg_events))) or '无'}" ] if bg_events else []),
            },
            {
                "title": "模型参与情况",
                "paragraphs": ["本会话参与模型及其承担任务如下："],
                "items": model_items,
            },
            {
                "title": "Token 用量与执行统计",
                "paragraphs": [
                    "本通讯周期内 Token 用量、API 调用、对话轮次及工具执行步数统计如下，供合规审计与成本核算参考：",
                ],
                "items": token_items,
            },
            {
                "title": "成果与验收结论",
                "paragraphs": [f"截至公文生成时，会话最近可提取的办结性结论为：{last_assistant or '会话尚未形成明确的最终回复'}。该结论仅反映当前日志已记载内容，不对尚未完成的事项作扩大认定。"],
                "items": [],
            },
            {
                "title": "后续运行与归档要求",
                "paragraphs": [
                    "有关责任单元应继续核对生成物、测试记录和运行状态，发现异常及时处置；本次完整会话日志、全部后台执行记录及生成公文应一并归档，确保办理过程可追溯、每名劳动同志的付出可查证。"
                ],
                "items": [],
            },
        ],
        "attachments": [],
        "closing": "请各有关单位结合职责抓好落实，并及时反馈后续运行中发现的问题。",
        "signatureModels": "、".join(model_names),
    }

    if out_path:
        with open(out_path, "w", encoding="utf8") as f:
            json.dump(draft, f, ensure_ascii=False, indent=2)
        print(f"OK draft -> {out_path}（{sid_label}，事件 {total} 条，模型 {len(model_names)} 个）")
    else:
        print(json.dumps(draft, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
