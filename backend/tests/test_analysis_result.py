"""Tests for the analysis-result write-back loop."""

import pytest

from services.analysis_result import parse_entities_from_analysis


SAMPLE_ANALYSIS = """# 分析结果

## 1. 一句话结论

有价值。

## 4. 相关公司映射

### 美股
- NVIDIA (NVDA)

## 9. 结构化实体输出

```json
{
  "entities": [
    {"name": "NVIDIA", "entity_type": "company", "market": "美股",
     "ticker": "NVDA", "role": "subject", "confidence": 0.9,
     "evidence": "正文主体"},
    {"name": "天孚通信", "market": "A股", "ticker": "300394",
     "role": "supplier", "confidence": 1.7}
  ]
}
```
"""


class TestParser:
    def test_parses_trailing_json_block(self):
        entities = parse_entities_from_analysis(SAMPLE_ANALYSIS)
        assert len(entities) == 2
        assert entities[0]["name"] == "NVIDIA"
        assert entities[0]["ticker"] == "NVDA"

    def test_confidence_clamped(self):
        entities = parse_entities_from_analysis(SAMPLE_ANALYSIS)
        assert entities[1]["confidence"] == 1.0

    def test_picks_valid_block_among_several(self):
        text = (
            "```json\n{\"other\": 1}\n```\n"
            + SAMPLE_ANALYSIS
            + "\n后记：```json\n{broken\n```\n"
        )
        entities = parse_entities_from_analysis(text)
        assert {e["name"] for e in entities} == {"NVIDIA", "天孚通信"}

    def test_skips_nameless_items(self):
        text = '```json\n{"entities": [{"name": "  "}, {"name": "AMD"}]}\n```'
        entities = parse_entities_from_analysis(text)
        assert [e["name"] for e in entities] == ["AMD"]

    def test_raises_without_block(self):
        with pytest.raises(ValueError):
            parse_entities_from_analysis("普通文本，没有代码块")

    def test_raises_on_malformed_json_only(self):
        with pytest.raises(ValueError):
            parse_entities_from_analysis("```json\n{oops\n```")


class TestEndpoint:
    def _create(self, client, auth_headers, sample_page_data):
        resp = client.post(
            "/capture/page", json=sample_page_data, headers=auth_headers
        )
        assert resp.status_code == 201
        return resp.json()["id"]

    def test_full_loop(self, client, auth_headers, sample_page_data):
        capture_id = self._create(client, auth_headers, sample_page_data)

        resp = client.post(
            f"/captures/{capture_id}/analysis-result",
            json={"analysis_markdown": SAMPLE_ANALYSIS},
            headers=auth_headers,
        )
        assert resp.status_code == 200
        data = resp.json()
        assert data["entities_extracted"] == 2
        assert data["analysis_path"].endswith(".analysis.md")

        # Analysis file archived
        from pathlib import Path

        archived = Path(data["analysis_path"])
        assert archived.exists()
        assert "结构化实体输出" in archived.read_text(encoding="utf-8")

        # Entities queryable
        resp = client.get(f"/captures/{capture_id}/entities", headers=auth_headers)
        assert {e["name"] for e in resp.json()["entities"]} == {"NVIDIA", "天孚通信"}

        # Status advanced
        resp = client.get("/captures/recent", headers=auth_headers)
        assert resp.status_code == 200
        stats = client.get("/entities/stats", headers=auth_headers).json()
        assert stats["entities"][0]["mention_count"] == 1

    def test_unparseable_analysis_is_422(self, client, auth_headers, sample_page_data):
        capture_id = self._create(client, auth_headers, sample_page_data)
        resp = client.post(
            f"/captures/{capture_id}/analysis-result",
            json={"analysis_markdown": "没有 JSON 块的分析"},
            headers=auth_headers,
        )
        assert resp.status_code == 422

    def test_unknown_capture_404(self, client, auth_headers):
        resp = client.post(
            "/captures/nope/analysis-result",
            json={"analysis_markdown": SAMPLE_ANALYSIS},
            headers=auth_headers,
        )
        assert resp.status_code == 404


def test_prompt_template_instructs_json_block():
    from services.analysis_prompt import ANALYSIS_TEMPLATE

    assert "```json" in ANALYSIS_TEMPLATE
    assert "结构化实体输出" in ANALYSIS_TEMPLATE
