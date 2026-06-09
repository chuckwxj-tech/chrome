"""Generate investment research analysis prompt from capture data."""

from datetime import datetime, timezone
from pathlib import Path
from config import get_config


ANALYSIS_TEMPLATE = """# 投研信息分析任务

请分析下面这条资料，并按固定结构输出。

## 用户研究意图

{{research_intent}}

## 原始标题

{{title}}

## 原始链接

{{url}}

## 用户备注

{{user_notes}}

## 正文内容

{{content}}

---

请输出：

## 1. 一句话结论

判断这条信息有没有投研价值。

## 2. 事实摘要

只提炼事实，不要脑补。

## 3. 产业链位置

归类到：
- AI服务器
- 光通信 / CPO / EML / SiPh
- PCB / HDI / mSAP / 载板
- HBM / 存储
- MLCC / 被动元件
- 半导体设备
- 算力租赁 / AIDC
- 其他

## 4. 相关公司映射

分市场列出：

### A股

### 港股

### 美股

### 台股 / 日股 / 韩股

## 5. 催化剂

说明是否有：
- 订单
- 涨价
- 产能扩张
- 客户验证
- 技术路线变化
- 政策变化
- 财报变化

## 6. 证据强度

按 L1-L4 评级：

- L1：公司公告、财报、官网、监管文件、论文、专利
- L2：权威媒体、产业媒体、会议纪要
- L3：X / KOL / 论坛传闻
- L4：无法验证的二手消息

## 7. 交易价值

打分 0-5：

- 新颖度
- 可信度
- 与当前持仓相关度
- 可交易性
- 时间敏感度

## 8. 待核查问题

列出需要继续查证的问题。
"""


def build_analysis_prompt(capture: dict) -> str:
    """Render the analysis prompt template with capture data."""
    return (
        ANALYSIS_TEMPLATE.replace("{{research_intent}}", capture.get("research_intent", "") or "_无_")
        .replace("{{title}}", capture.get("title", "Untitled"))
        .replace("{{url}}", capture.get("url", ""))
        .replace("{{user_notes}}", capture.get("user_notes", "") or "_无备注_")
        .replace("{{content}}", capture.get("content", "")[:50000])
    )


def write_analysis_prompt(capture: dict) -> str:
    """Generate and write analysis_prompt.md. Returns the file path."""
    prompt = build_analysis_prompt(capture)
    storage_date = capture.get("storage_date") or datetime.now(timezone.utc).strftime(
        "%Y-%m-%d"
    )
    file_slug = capture.get("file_slug", "unknown")
    date_dir = Path(get_config().storage_root) / storage_date
    date_dir.mkdir(parents=True, exist_ok=True)
    file_path = date_dir / f"{file_slug}.analysis_prompt.md"
    file_path.write_text(prompt, encoding="utf-8")
    return str(file_path)
