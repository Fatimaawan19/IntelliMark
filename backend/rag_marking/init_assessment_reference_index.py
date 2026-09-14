from __future__ import annotations

import json
import logging
from datetime import datetime
from pathlib import Path

from faiss_vector_store import FAISSVectorStore

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")
logger = logging.getLogger(__name__)


REFERENCE_INDEX_DIR = Path(__file__).resolve().parent / "faiss_assessment_reference_index"
REFERENCE_INDEX_DIR.mkdir(parents=True, exist_ok=True)


def main() -> None:
    store = FAISSVectorStore(index_dir=REFERENCE_INDEX_DIR)
    stats = store.stats()
    print(
        json.dumps(
            {
                "timestamp": datetime.utcnow().isoformat(),
                "success": True,
                "message": "Assessment reference FAISS index initialized",
                "stats": stats,
            }
        )
    )


if __name__ == "__main__":
    main()

