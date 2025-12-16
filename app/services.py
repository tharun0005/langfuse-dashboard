import os
import requests
import logging
from dotenv import load_dotenv
from typing import List, Dict, Any

load_dotenv()
logger = logging.getLogger(__name__)

host = os.getenv("LANGFUSE_HOST")
public_key = os.getenv("LANGFUSE_PUBLIC_KEY")
secret_key = os.getenv("LANGFUSE_SECRET_KEY")


def get_llm_generations(limit: int = 20) -> List[Dict[str, Any]]:
    logger.info(f"Fetching {limit} LLM generations from Langfuse")

    if not all([host, public_key, secret_key]):
        error_msg = f"Missing Langfuse env: HOST={bool(host)}, PK={bool(public_key)}, SK={bool(secret_key)}"
        logger.error(error_msg)
        return [{"error": error_msg}]

    try:
        logger.debug(f"Calling {host}/api/public/observations")
        resp = requests.get(
            f"{host}/api/public/observations",
            params={
                "limit": limit,
                "name": "llm_generation",
                "type": "GENERATION",
                "order": "desc"
            },
            auth=(public_key, secret_key),
            timeout=15,
        )

        logger.info(f"Langfuse API response: {resp.status_code}")

        if resp.status_code != 200:
            error_msg = f"HTTP {resp.status_code}: {resp.text[:200]}"
            logger.error(error_msg)
            return [{"error": error_msg}]

        data = resp.json()
        raw = data.get("data", [])
        logger.info(f"Found {len(raw)} observations")

    except requests.exceptions.RequestException as e:
        error_msg = f"Network error: {str(e)}"
        logger.error(error_msg)
        return [{"error": error_msg}]
    except Exception as e:
        logger.error(f"Unexpected error: {str(e)}", exc_info=True)
        return [{"error": f"Unexpected error: {str(e)}"}]

    items = []
    for i, obs in enumerate(raw[:limit]):
        try:
            usage = obs.get("usageDetails", {}) or {}

            messages = obs.get("input", [])
            input_content = ""
            if isinstance(messages, list) and len(messages) > 0:
                user_msg = next((m for m in messages if m.get("role") == "user"), None)
                input_content = user_msg.get("content", "") if user_msg else ""

            item = {
                "id": obs.get("id", f"obs_{i}")[-8:],
                "traceId": obs.get("traceId", ""),
                "time": obs.get("startTime", ""),
                "model": obs.get("model", "unknown"),
                "latency_ms": obs.get("latency", 0) or 0,
                "time_to_first_token_s": obs.get("timeToFirstToken", 0) or 0,
                "input_tokens": usage.get("input", 0) or 0,
                "output_tokens": usage.get("output", 0) or 0,
                "total_tokens": usage.get("total", 0) or 0,
                "input_content": str(input_content)[:1000],
                "output_content": str(obs.get("output", ""))[:1000],
            }
            items.append(item)

        except Exception as e:
            logger.warning(f"Error processing observation {obs.get('id')}: {str(e)}")
            continue

    logger.info(f"Returning {len(items)} processed items")
    return items if items else [{"error": "No llm_generation observations found"}]
