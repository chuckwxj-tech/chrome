"""Parse LLM analysis output: extract the structured entities JSON block."""

import json
import re

_JSON_BLOCK = re.compile(r"```json\s*(.*?)```", re.DOTALL)


def parse_entities_from_analysis(markdown: str) -> list[dict]:
    """Extract entity mappings from the trailing ```json block of an analysis.

    Returns a list of normalized entity dicts (name required; confidence
    clamped to [0, 1]). Raises ValueError if no parseable block is found —
    the template instructs the LLM to always emit one, so absence means the
    output didn't follow the contract and the caller should surface that.
    """
    blocks = _JSON_BLOCK.findall(markdown)
    if not blocks:
        raise ValueError("no ```json block found in analysis output")

    last_error: Exception | None = None
    # The entities block is instructed to come last; scan from the end and
    # accept the first block that parses into the expected shape.
    for raw in reversed(blocks):
        try:
            data = json.loads(raw)
        except json.JSONDecodeError as e:
            last_error = e
            continue
        items = data.get("entities") if isinstance(data, dict) else None
        if not isinstance(items, list):
            last_error = ValueError("json block has no 'entities' list")
            continue
        return [_normalize(item) for item in items if _valid(item)]

    raise ValueError(f"no valid entities json block: {last_error}")


def _valid(item) -> bool:
    return isinstance(item, dict) and bool(str(item.get("name", "")).strip())


def _normalize(item: dict) -> dict:
    confidence = item.get("confidence")
    if isinstance(confidence, (int, float)):
        confidence = max(0.0, min(1.0, float(confidence)))
    else:
        confidence = None
    return {
        "name": str(item["name"]).strip()[:200],
        "entity_type": _opt_str(item.get("entity_type")),
        "market": _opt_str(item.get("market")),
        "ticker": _opt_str(item.get("ticker")),
        "canonical_name": _opt_str(item.get("canonical_name")),
        "role": _opt_str(item.get("role")),
        "confidence": confidence,
        "evidence": _opt_str(item.get("evidence")),
    }


def _opt_str(value) -> str | None:
    if value is None:
        return None
    text = str(value).strip()
    return text or None
