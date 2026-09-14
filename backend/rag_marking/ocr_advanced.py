import argparse
import json
import os
import sys
import re
import math
from typing import Optional

try:
    import cv2
    import numpy as np
    import pytesseract
    from pytesseract import Output
except ImportError as e:
    print(json.dumps({"success": False, "error": f"Missing dependency: {e}"}))
    sys.exit(1)


# Configure Tesseract path (Windows default)
TESSERACT_PATH = os.environ.get("TESSERACT_PATH", r"C:\Program Files\Tesseract-OCR\tesseract.exe")
if os.path.exists(TESSERACT_PATH):
    pytesseract.pytesseract.tesseract_cmd = TESSERACT_PATH


# =========================
# Image preprocessing steps
# =========================

def load_image(image_path: str) -> np.ndarray:
    img = cv2.imread(image_path)
    if img is None:
        raise ValueError(f"Could not read image: {image_path}")
    return img


def to_grayscale(img: np.ndarray) -> np.ndarray:
    if len(img.shape) == 2:
        return img
    return cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)


def remove_shadow(gray: np.ndarray) -> np.ndarray:
    """Remove shadows from mobile camera photos using morphological operations."""
    # Dilate to find background
    dilated = cv2.dilate(gray, np.ones((7, 7), np.uint8))
    # Blur to estimate background brightness
    bg = cv2.medianBlur(dilated, 21)
    # Difference removes shadow
    diff = 255 - cv2.absdiff(gray, bg)
    # Normalize
    normalized = cv2.normalize(diff, None, alpha=0, beta=255, norm_type=cv2.NORM_MINMAX, dtype=cv2.CV_8U)
    return normalized


def enhance_contrast_clahe(gray: np.ndarray) -> np.ndarray:
    """Contrast Limited Adaptive Histogram Equalization - excellent for uneven lighting."""
    clahe = cv2.createCLAHE(clipLimit=2.0, tileGridSize=(8, 8))
    return clahe.apply(gray)


def denoise(gray: np.ndarray, h: int = 10) -> np.ndarray:
    """Non-local means denoising preserves edges better than blur."""
    return cv2.fastNlMeansDenoising(gray, h=h)


def upscale_if_small(gray: np.ndarray, min_width: int = 2000) -> np.ndarray:
    """Upscale low-resolution images for better OCR."""
    h, w = gray.shape
    if w < min_width:
        scale = min_width / w
        return cv2.resize(gray, None, fx=scale, fy=scale, interpolation=cv2.INTER_CUBIC)
    return gray


def deskew(gray: np.ndarray) -> np.ndarray:
    """Detect and correct skew angle in scanned/photographed documents."""
    try:
        # Threshold to binary
        _, bw = cv2.threshold(gray, 0, 255, cv2.THRESH_BINARY_INV + cv2.THRESH_OTSU)

        # Find all non-zero (text) pixel coordinates
        coords = np.column_stack(np.where(bw > 0))
        if len(coords) < 100:
            return gray

        # Compute the angle of the minAreaRect
        angle = cv2.minAreaRect(coords)[-1]

        # Normalize the angle
        if angle < -45:
            angle = -(90 + angle)
        else:
            angle = -angle

        # Skip if skew is minimal
        if abs(angle) < 0.5 or abs(angle) > 15:
            return gray

        # Rotate
        (h, w) = gray.shape
        center = (w // 2, h // 2)
        M = cv2.getRotationMatrix2D(center, angle, 1.0)
        rotated = cv2.warpAffine(gray, M, (w, h), flags=cv2.INTER_CUBIC, borderMode=cv2.BORDER_REPLICATE)
        return rotated
    except Exception:
        return gray


def sharpen(gray: np.ndarray, intensity: float = 1.0) -> np.ndarray:
    """Sharpen image to enhance text edges."""
    kernel = np.array([[0, -1, 0], [-1, 4 + intensity, -1], [0, -1, 0]])
    return cv2.filter2D(gray, -1, kernel)


def adaptive_threshold(gray: np.ndarray, block_size: int = 31, c: int = 10) -> np.ndarray:
    """Adaptive thresholding handles varying lighting."""
    return cv2.adaptiveThreshold(
        gray, 255, cv2.ADAPTIVE_THRESH_GAUSSIAN_C, cv2.THRESH_BINARY, block_size, c
    )


def otsu_threshold(gray: np.ndarray) -> np.ndarray:
    """Otsu's method for automatic threshold determination."""
    _, thresh = cv2.threshold(gray, 0, 255, cv2.THRESH_BINARY + cv2.THRESH_OTSU)
    return thresh


def bilateral_filter(gray: np.ndarray) -> np.ndarray:
    """Bilateral filter preserves edges while smoothing."""
    return cv2.bilateralFilter(gray, 9, 75, 75)


# =========================
# Pipeline variants
# =========================

def pipeline_for_mobile_photo(image_path: str) -> np.ndarray:
    """Comprehensive pipeline for mobile camera photos with shadows/lighting issues."""
    img = load_image(image_path)
    gray = to_grayscale(img)
    gray = upscale_if_small(gray)
    gray = remove_shadow(gray)
    gray = enhance_contrast_clahe(gray)
    gray = deskew(gray)
    gray = denoise(gray, h=10)
    return adaptive_threshold(gray, block_size=25, c=10)


def pipeline_for_scanned_document(image_path: str) -> np.ndarray:
    """Pipeline for properly scanned/clean documents."""
    img = load_image(image_path)
    gray = to_grayscale(img)
    gray = upscale_if_small(gray)
    gray = deskew(gray)
    gray = denoise(gray, h=8)
    return otsu_threshold(gray)


def pipeline_for_handwriting(image_path: str) -> np.ndarray:
    """Pipeline tuned for handwritten content."""
    img = load_image(image_path)
    gray = to_grayscale(img)
    gray = upscale_if_small(gray, min_width=2400)
    gray = deskew(gray)
    gray = enhance_contrast_clahe(gray)
    gray = bilateral_filter(gray)
    return adaptive_threshold(gray, block_size=35, c=12)


def pipeline_raw_upscaled(image_path: str) -> np.ndarray:
    """Minimal preprocessing - just upscale and deskew."""
    img = load_image(image_path)
    gray = to_grayscale(img)
    gray = upscale_if_small(gray)
    gray = deskew(gray)
    return gray


def pipeline_sharp_otsu(image_path: str) -> np.ndarray:
    """Sharpen + Otsu - good for blurry images."""
    img = load_image(image_path)
    gray = to_grayscale(img)
    gray = upscale_if_small(gray)
    gray = deskew(gray)
    gray = sharpen(gray, intensity=1.0)
    return otsu_threshold(gray)


PIPELINES = {
    "mobile_photo": pipeline_for_mobile_photo,
    "scanned": pipeline_for_scanned_document,
    "handwriting": pipeline_for_handwriting,
    "raw_upscaled": pipeline_raw_upscaled,
    "sharp_otsu": pipeline_sharp_otsu,
}


# =========================
# OCR with structure preservation
# =========================

def run_tesseract_with_structure(image: np.ndarray, lang: str = "eng", psm: int = 6) -> dict:
    """
    Run Tesseract and return structured text with confidence scores.

    Returns:
        {
            'text': str,                # reconstructed text with proper line order
            'confidence': float,        # average confidence (0-100)
            'word_count': int,
            'data': dict,               # raw pytesseract output_dict
        }
    """
    config = f"-l {lang} --oem 1 --psm {psm} -c preserve_interword_spaces=1"
    try:
        data = pytesseract.image_to_data(image, config=config, output_type=Output.DICT)
    except Exception as e:
        return {"text": "", "confidence": 0, "word_count": 0, "data": {}}

    # Group words by (block, paragraph, line)
    structure: dict = {}
    confidences = []
    word_count = 0

    n = len(data["text"])
    for i in range(n):
        word = (data["text"][i] or "").strip()
        if not word:
            continue
        conf = float(data["conf"][i]) if data["conf"][i] not in ("-1", -1, "") else -1
        if conf < 0:
            continue

        block = data["block_num"][i]
        par = data["par_num"][i]
        line = data["line_num"][i]
        top = data["top"][i]
        left = data["left"][i]

        key = (block, par, line)
        if key not in structure:
            structure[key] = {"words": [], "top": top, "left": left}
        structure[key]["words"].append({"text": word, "conf": conf, "left": left})

        confidences.append(conf)
        word_count += 1

    # Sort lines by block → paragraph → top (Y) coordinate
    sorted_keys = sorted(structure.keys(), key=lambda k: (k[0], k[1], structure[k]["top"]))

    # Build text with paragraph breaks
    lines_out = []
    last_block = None
    last_par = None
    for key in sorted_keys:
        block, par, _line = key
        if last_block is not None and (block != last_block or par != last_par):
            lines_out.append("")  # blank line = paragraph break
        # Sort words in line by X coordinate
        words_sorted = sorted(structure[key]["words"], key=lambda w: w["left"])
        line_text = " ".join(w["text"] for w in words_sorted)
        lines_out.append(line_text)
        last_block = block
        last_par = par

    text = "\n".join(lines_out).strip()
    avg_conf = sum(confidences) / len(confidences) if confidences else 0

    return {
        "text": text,
        "confidence": round(avg_conf, 2),
        "word_count": word_count,
        "data": data,
    }


# =========================
# Text cleaning & dedup
# =========================

COMMON_WORDS = {
    "the", "and", "is", "of", "to", "in", "a", "that", "it", "with", "for", "as", "are",
    "this", "be", "by", "on", "an", "or", "from", "we", "you", "they", "have", "has",
    "was", "were", "will", "can", "not", "but", "if", "all", "more", "some", "any",
    "variable", "experiment", "random", "value", "function", "data", "result",
    "answer", "question", "method", "process", "system", "tossing", "coin", "head",
    "tail", "outcome", "input", "output", "number", "numbers", "type", "types",
    "definition", "example", "examples", "because", "when", "where", "what", "how",
    "which", "use", "used", "uses", "using", "called", "represents", "represent",
    "would", "could", "should", "than", "then", "also", "such", "must",
}


def clean_line(line: str) -> str:
    """Clean a single line of OCR output."""
    # Replace non-printable ASCII with space
    line = re.sub(r"[^\x20-\x7E]", " ", line)
    # Collapse multiple spaces
    line = re.sub(r"\s+", " ", line)
    # Remove standalone weird characters (single isolated non-letter chars)
    line = re.sub(r"\s+[^a-zA-Z0-9\s]\s+", " ", line)
    return line.strip()


def is_noise_line(line: str) -> bool:
    """Detect if a line is mostly noise."""
    line = line.strip()
    if not line:
        return False  # keep blank lines for paragraph breaks

    non_space = sum(1 for c in line if not c.isspace())
    letters = sum(1 for c in line if c.isalpha())
    symbols = sum(1 for c in line if not c.isalnum() and not c.isspace())

    if non_space == 0:
        return True

    # Too few letters
    if non_space > 5 and letters / non_space < 0.3:
        return True

    # Too many symbols
    if non_space > 5 and symbols / non_space > 0.5:
        return True

    # Mostly fragments (short tokens)
    words = line.split()
    if len(words) > 5:
        fragments = sum(1 for w in words if len(w) <= 2 and not w.isalpha())
        if fragments / len(words) > 0.5:
            return True

    # Single very short non-letter line
    if letters < 3 and non_space < 5:
        return True

    return False


def deduplicate_lines(lines: list) -> list:
    """Remove near-duplicate consecutive lines (common with sparse PSM modes)."""
    deduped = []
    for line in lines:
        line = line.strip()
        if not line:
            if deduped and deduped[-1] != "":
                deduped.append(line)
            continue
        is_dup = False
        line_lower = line.lower().strip()
        line_words = set(w for w in line_lower.split() if len(w) >= 3)
        for prev in deduped[-6:]:
            if not prev:
                continue
            prev_lower = prev.lower().strip()
            if line_lower == prev_lower:
                is_dup = True
                break
            if line_lower in prev_lower or prev_lower in line_lower:
                if min(len(line_lower), len(prev_lower)) > 5:
                    is_dup = True
                    break
            prev_words = set(w for w in prev_lower.split() if len(w) >= 3)
            if len(line_words) >= 3 and len(prev_words) >= 3:
                overlap = len(line_words & prev_words)
                if overlap / min(len(line_words), len(prev_words)) > 0.7:
                    is_dup = True
                    break
        if not is_dup:
            deduped.append(line)
    return deduped


def reconstruct_sentences(text: str) -> str:
    """
    Reconstruct fragmented OCR text into proper sentences.
    - De-hyphenate line breaks ("vari-\nable" -> "variable")
    - Join short fragments that belong together
    """
    lines = text.split("\n")
    result = []
    i = 0
    while i < len(lines):
        cur = lines[i].rstrip()

        # Skip blank lines (paragraph breaks)
        if not cur.strip():
            if result and result[-1] != "":
                result.append("")
            i += 1
            continue

        # De-hyphenate
        if cur.endswith("-") and i + 1 < len(lines):
            nxt = lines[i + 1].strip()
            if nxt and re.match(r"^[a-zA-Z]", nxt):
                cur = cur[:-1] + nxt
                i += 1

        result.append(cur)
        i += 1

    return "\n".join(result).strip()


def clean_text_output(text: str) -> str:
    """Full cleaning pipeline for OCR output."""
    if not text:
        return ""

    lines = text.split("\n")
    cleaned_lines = []
    for line in lines:
        if not line.strip():
            cleaned_lines.append("")
            continue
        cleaned = clean_line(line)
        if not cleaned:
            continue
        if is_noise_line(cleaned):
            continue
        cleaned_lines.append(cleaned)

    # Deduplicate near-duplicate lines
    deduped = deduplicate_lines(cleaned_lines)

    # Reconstruct sentences
    text_out = reconstruct_sentences("\n".join(deduped))

    # Collapse 3+ blank lines into 1 paragraph break
    text_out = re.sub(r"\n{3,}", "\n\n", text_out)

    return text_out.strip()


# =========================
# Scoring & selection
# =========================

def score_text_quality(text: str, ocr_confidence: float) -> dict:
    """
    Score the quality of OCR text.

    Returns dict with:
    - score: int (composite score)
    - letter_count: int
    - word_count: int
    - real_word_count: int (recognizable English words)
    - confidence_score: float (Tesseract's own confidence)
    """
    if not text:
        return {"score": 0, "letter_count": 0, "word_count": 0, "real_word_count": 0, "confidence_score": 0}

    letter_count = sum(1 for c in text if c.isalpha())
    words = re.findall(r"\b[a-zA-Z]{2,}\b", text)
    word_count = len(words)
    real_words = [w.lower() for w in words if w.lower() in COMMON_WORDS or len(w) >= 5]
    real_word_count = len(real_words)

    # Composite score
    score = letter_count
    score += real_word_count * 30
    score += word_count * 3
    # Heavy bonus for high OCR confidence
    score += int(ocr_confidence * 2)

    return {
        "score": score,
        "letter_count": letter_count,
        "word_count": word_count,
        "real_word_count": real_word_count,
        "confidence_score": ocr_confidence,
    }


# =========================
# Main OCR function
# =========================

def ocr_single_image(image_path: str, lang: str = "eng", fast_mode: bool = True) -> dict:
    """
    Run OCR on a single image with multiple pipelines and PSM modes.
    Returns the best result with confidence.

    fast_mode=True: Use minimal combinations + early exit (default, ~10-15s per image)
    fast_mode=False: Try all combinations for best quality (~60-90s per image)
    """
    # Fast mode: Only test the 3 most effective pipelines + 2 PSMs (6 combinations)
    # Slow mode: 5 pipelines × 4 PSMs (20 combinations)
    if fast_mode:
        pipelines_to_try = ["sharp_otsu", "handwriting", "raw_upscaled"]
        psm_modes = [6, 11]  # uniform block + sparse text (works best for handwriting)
    else:
        pipelines_to_try = list(PIPELINES.keys())
        psm_modes = [6, 4, 3, 11]

    best = {
        "text": "",
        "confidence": 0,
        "word_count": 0,
        "score": 0,
        "pipeline": "",
        "psm": 0,
    }

    for pipeline_name in pipelines_to_try:
        pipeline_fn = PIPELINES.get(pipeline_name)
        if not pipeline_fn:
            continue
        try:
            preprocessed = pipeline_fn(image_path)
        except Exception:
            continue

        for psm in psm_modes:
            try:
                result = run_tesseract_with_structure(preprocessed, lang=lang, psm=psm)
            except Exception:
                continue

            raw_text = result["text"]
            cleaned = clean_text_output(raw_text)
            confidence = result["confidence"]

            quality = score_text_quality(cleaned, confidence)

            if quality["score"] > best["score"]:
                best = {
                    "text": cleaned,
                    "raw_text": raw_text,
                    "confidence": confidence,
                    "word_count": result["word_count"],
                    "real_word_count": quality["real_word_count"],
                    "letter_count": quality["letter_count"],
                    "score": quality["score"],
                    "pipeline": pipeline_name,
                    "psm": psm,
                }

                # Early exit if we got high-quality result (saves 30-60s)
                if confidence >= 75 and quality["real_word_count"] >= 20:
                    needs_review = False
                    return {
                        **best,
                        "needs_manual_review": needs_review,
                        "quality_label": "high",
                    }

    # Determine if needs manual review (low confidence or low quality)
    needs_review = (
        best["confidence"] < 50 or
        best["real_word_count"] < 5 or
        best["letter_count"] < 50
    )

    return {
        **best,
        "needs_manual_review": needs_review,
        "quality_label": (
            "high" if best["confidence"] >= 70 and best["real_word_count"] >= 15 else
            "medium" if best["confidence"] >= 50 and best["real_word_count"] >= 8 else
            "low"
        ),
    }


def ocr_multiple_images(image_paths: list, lang: str = "eng", fast_mode: bool = True) -> dict:
    """Process multiple images and combine results in order."""
    results = []
    combined_text = []
    total_confidence = 0
    total_pages = 0
    any_needs_review = False

    for idx, image_path in enumerate(image_paths):
        result = ocr_single_image(image_path, lang=lang, fast_mode=fast_mode)
        results.append({
            "page": idx + 1,
            "image": os.path.basename(image_path),
            "text": result["text"],
            "confidence": result["confidence"],
            "word_count": result["word_count"],
            "pipeline": result["pipeline"],
            "psm": result["psm"],
            "needs_manual_review": result["needs_manual_review"],
            "quality_label": result["quality_label"],
        })
        if result["text"]:
            if idx > 0:
                combined_text.append(f"\n\n--- Page {idx + 1} ---\n")
            combined_text.append(result["text"])
            total_confidence += result["confidence"]
            total_pages += 1
        if result["needs_manual_review"]:
            any_needs_review = True

    avg_confidence = total_confidence / total_pages if total_pages > 0 else 0
    full_text = "".join(combined_text).strip()

    return {
        "success": True,
        "text": full_text,
        "text_length": len(full_text),
        "page_count": len(image_paths),
        "average_confidence": round(avg_confidence, 2),
        "needs_manual_review": any_needs_review,
        "quality_label": (
            "high" if avg_confidence >= 70 else
            "medium" if avg_confidence >= 50 else
            "low"
        ),
        "pages": results,
    }


# =========================
# CLI
# =========================

def main():
    parser = argparse.ArgumentParser(description="Advanced OCR with structure preservation")
    parser.add_argument("--image", help="Path to single image")
    parser.add_argument("--images", help="Comma-separated paths to multiple images")
    parser.add_argument("--lang", default="eng", help="Tesseract language (default: eng)")
    parser.add_argument("--output-json", action="store_true", help="Output as JSON")
    parser.add_argument("--slow", action="store_true", help="Slow but more thorough mode (tries all combinations)")
    args = parser.parse_args()

    if not args.image and not args.images:
        print(json.dumps({"success": False, "error": "Provide --image or --images"}))
        sys.exit(1)

    image_paths = []
    if args.image:
        image_paths = [args.image]
    elif args.images:
        image_paths = [p.strip() for p in args.images.split(",") if p.strip()]

    for p in image_paths:
        if not os.path.exists(p):
            print(json.dumps({"success": False, "error": f"Image not found: {p}"}))
            sys.exit(1)

    try:
        result = ocr_multiple_images(image_paths, lang=args.lang, fast_mode=not args.slow)
        if args.output_json:
            print(json.dumps(result))
        else:
            print(result["text"])
    except Exception as e:
        print(json.dumps({"success": False, "error": str(e)}))
        sys.exit(1)


if __name__ == "__main__":
    main()
